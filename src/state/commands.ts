// commands.jsonl: append, read from an offset, and the orchestrator's persisted cursor.
//
// Delivery is exactly once in the normal case: the cursor is saved right after each
// command is executed. If the orchestrator crashes between executing a command and
// saving the cursor, that command runs again on restart (at-least-once). Executors of
// non-idempotent commands can guard against this by checking, before acting, for a
// command-executed event whose `command` field holds this Command.id.
//
// Lines must stay under 4 KB, so every string over 2 KB in a command (a long comment or
// instruction), then more strings, largest first, until the line fits, are stored in
// commands-data/<id>.<n>.txt and replaced in the line by {"textFile": <path relative to
// the state directory>}. readCommands puts the text back, so callers never see it.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command, Iso } from "../types.ts";
import { appendJsonLine, checkId, MAX_LINE_BYTES, readJsonLinesFrom, writeFileAtomic } from "./jsonl.ts";

const MAX_INLINE_TEXT_BYTES = 2048;
// Smaller strings would hardly shrink the line: the {"textFile": …} reference that
// replaces them is about this long.
const MIN_MOVED_BYTES = 64;
// Kept inline so the raw file stays greppable and routable.
const ENVELOPE_KEYS = new Set(["v", "id", "t", "cmd", "request"]);

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

// A command as the caller builds it: id, v and t are filled in when missing.
export type CommandInput = DistributiveOmit<Command, "v" | "t" | "id"> & { v?: 1; t?: Iso; id?: string };

export function commandsPath(stateDir: string): string {
  return join(stateDir, "commands.jsonl");
}

export function cursorPath(stateDir: string): string {
  return join(stateDir, "commands.cursor.json");
}

export function newCommandId(t: Iso): string {
  return `c-${t.replace(/[-:.]/g, "").replace("T", "-").slice(0, 15)}-${randomBytes(4).toString("hex")}`;
}

export function appendCommand(stateDir: string, command: CommandInput): Command {
  const t = command.t ?? new Date().toISOString();
  const full = { ...command, v: command.v ?? 1, t, id: command.id ?? newCommandId(t) } as Command;
  checkId(full.id, "command id");
  appendJsonLine(commandsPath(stateDir), externalizeTexts(stateDir, full), `${full.cmd} command`);
  return full;
}

// Moves strings to files, largest first: every string over 2 KB, then more until the
// line fits. File names use a counter, never command keys, which can come from an agent.
function externalizeTexts(stateDir: string, command: Command): unknown {
  const copy = structuredClone(command) as unknown;
  const strings: { holder: Record<string | number, unknown>; key: string | number; bytes: number }[] = [];
  const collect = (value: unknown) => {
    if (value === null || typeof value !== "object") return;
    const holder = value as Record<string | number, unknown>;
    for (const key of Object.keys(holder)) {
      const v = holder[key];
      if (typeof v === "string") {
        if (holder === copy && ENVELOPE_KEYS.has(key)) continue;
        if (Buffer.byteLength(v) < MIN_MOVED_BYTES) continue;
        strings.push({ holder, key, bytes: Buffer.byteLength(v) });
      } else {
        collect(v);
      }
    }
  };
  collect(copy);
  strings.sort((a, b) => b.bytes - a.bytes);
  const lineBytes = () => Buffer.byteLength(JSON.stringify(copy)) + 1;
  const files: { textFile: string; text: string }[] = [];
  for (const s of strings) {
    if (s.bytes <= MAX_INLINE_TEXT_BYTES && lineBytes() <= MAX_LINE_BYTES) break;
    const textFile = join("commands-data", `${command.id}.${files.length + 1}.txt`);
    files.push({ textFile, text: s.holder[s.key] as string });
    s.holder[s.key] = { textFile };
  }
  if (files.length > 0) {
    mkdirSync(join(stateDir, "commands-data"), { recursive: true });
  }
  // Written before the command line, so a reader never finds a reference to a missing file.
  for (const f of files) {
    writeFileAtomic(join(stateDir, f.textFile), f.text);
  }
  return copy;
}

function internalizeTexts(stateDir: string, value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => internalizeTexts(stateDir, v));
  }
  if (value !== null && typeof value === "object") {
    const textFile = (value as { textFile?: unknown }).textFile;
    if (typeof textFile === "string" && Object.keys(value).length === 1) {
      if (!/^commands-data\/[A-Za-z0-9][A-Za-z0-9._-]*\.txt$/.test(textFile)) {
        throw new Error(`command text file outside commands-data: ${JSON.stringify(textFile)}`);
      }
      return readFileSync(join(stateDir, textFile), "utf8");
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, internalizeTexts(stateDir, v)]));
  }
  return value;
}

export interface CommandEntry {
  command: Command;
  end: number; // offset just after this command's line: the cursor value once it's executed
}

export function readCommandEntries(stateDir: string, fromOffset: number): { entries: CommandEntry[]; offset: number } {
  const { lines, offset } = readJsonLinesFrom(commandsPath(stateDir), fromOffset);
  return { entries: lines.map((l) => ({ command: internalizeTexts(stateDir, l.value) as Command, end: l.end })), offset };
}

export function readCommands(stateDir: string, fromOffset: number): { commands: Command[]; offset: number } {
  const { entries, offset } = readCommandEntries(stateDir, fromOffset);
  return { commands: entries.map((e) => e.command), offset };
}

export function loadCursor(stateDir: string): number {
  try {
    return (JSON.parse(readFileSync(cursorPath(stateDir), "utf8")) as { offset: number }).offset;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw e;
  }
}

export function saveCursor(stateDir: string, offset: number): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileAtomic(cursorPath(stateDir), JSON.stringify({ offset }) + "\n");
}

const inFlight = new Map<string, Promise<number>>();

// Executes the commands appended since the saved cursor, in order, saving the cursor
// after each one. If execute throws, the cursor stays before the failing command and
// the error propagates, so the command is retried on the next call; executors should
// record expected failures as command-executed events with ok: false, not throw.
// Overlapping calls for the same state directory are chained: each must read the
// cursor the previous one saved, or both would run the same commands.
export function processNewCommands(stateDir: string, execute: (command: Command) => void | Promise<void>): Promise<number> {
  const previous = inFlight.get(stateDir) ?? Promise.resolve(0);
  const run = previous
    .catch(() => 0)
    .then(async () => {
      const { entries } = readCommandEntries(stateDir, loadCursor(stateDir));
      for (const { command, end } of entries) {
        await execute(command);
        saveCursor(stateDir, end);
      }
      return entries.length;
    });
  inFlight.set(stateDir, run);
  run
    .catch(() => 0)
    .then(() => {
      if (inFlight.get(stateDir) === run) inFlight.delete(stateDir);
    });
  return run;
}
