// commands.jsonl: append, read from an offset, and the orchestrator's persisted cursor.
//
// Delivery is exactly once in the normal case: the cursor is saved right after each
// command is executed. If the orchestrator crashes between executing a command and
// saving the cursor, that command runs again on restart (at-least-once). Executors of
// non-idempotent commands can guard against this by checking for a command-executed
// event carrying the command id before acting.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command, Iso } from "../types.ts";
import { appendJsonLine, readJsonLinesFrom, writeFileAtomic } from "./jsonl.ts";

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
  appendJsonLine(commandsPath(stateDir), full, `${full.cmd} command`);
  return full;
}

export interface CommandEntry {
  command: Command;
  end: number; // offset just after this command's line: the cursor value once it's executed
}

export function readCommandEntries(stateDir: string, fromOffset: number): { entries: CommandEntry[]; offset: number } {
  const { lines, offset } = readJsonLinesFrom(commandsPath(stateDir), fromOffset);
  return { entries: lines.map((l) => ({ command: l.value as Command, end: l.end })), offset };
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

// Executes the commands appended since the saved cursor, in order, saving the cursor
// after each one. If execute throws, the cursor stays before the failing command and
// the error propagates, so the command is retried on the next call; executors should
// record expected failures as command-executed events with ok: false, not throw.
export async function processNewCommands(stateDir: string, execute: (command: Command) => void | Promise<void>): Promise<number> {
  const { entries } = readCommandEntries(stateDir, loadCursor(stateDir));
  for (const { command, end } of entries) {
    await execute(command);
    saveCursor(stateDir, end);
  }
  return entries.length;
}
