// requests/<requestId>/events.jsonl: append, read, list and tail.
import { existsSync, readdirSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { Event, Iso, RequestId } from "../types.ts";
import { appendJsonLine, checkId, readJsonLinesFrom } from "./jsonl.ts";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

// An event as the caller builds it: v and t are filled in when missing.
export type EventInput = DistributiveOmit<Event, "v" | "t"> & { v?: 1; t?: Iso };

export function eventsPath(stateDir: string, requestId: RequestId): string {
  checkId(requestId, "request id");
  return join(stateDir, "requests", requestId, "events.jsonl");
}

export function appendEvent(stateDir: string, event: EventInput): Event {
  const full = { ...event, v: event.v ?? 1, t: event.t ?? new Date().toISOString() } as Event;
  appendJsonLine(eventsPath(stateDir, full.request), full, `${full.type} event for ${full.request}`);
  return full;
}

// Events after a byte offset, plus the offset to continue from, with their data files read back.
export function readEventsFrom(stateDir: string, requestId: RequestId, fromOffset: number): { events: Event[]; offset: number } {
  const { lines, offset } = readJsonLinesFrom(eventsPath(stateDir, requestId), fromOffset);
  return { events: lines.map((l) => internalizeEvent(stateDir, requestId, l.value) as Event), offset };
}

// An event over the line limit has its biggest values in requests/<id>/event-data/ files, and
// {"dataFile": <path relative to stateDir>} in their place (see appendEventSafe in
// src/orchestrator/event-data.ts and docs/CONTRACTS.md). This puts them back. Only references to an
// existing file of this request's event-data/ are: anything else that looks like one (an agent's report
// can hold any JSON) stays as it is.
export function internalizeEvent(stateDir: string, requestId: RequestId, value: unknown): unknown {
  const pattern = new RegExp(`^requests/${requestId.replace(/\./g, "\\.")}/event-data/[A-Za-z0-9][A-Za-z0-9._-]*\\.json$`);
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v === null || typeof v !== "object") return v;
    const dataFile = (v as { dataFile?: unknown }).dataFile;
    if (typeof dataFile === "string" && Object.keys(v).length === 1 && pattern.test(dataFile) && existsSync(join(stateDir, dataFile))) {
      return walk(JSON.parse(readFileSync(join(stateDir, dataFile), "utf8")));
    }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
  };
  return walk(value);
}

export function readEvents(stateDir: string, requestId: RequestId): Event[] {
  return readEventsFrom(stateDir, requestId, 0).events;
}

export function listRequests(stateDir: string): RequestId[] {
  const dir = join(stateDir, "requests");
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "events.jsonl")))
    .map((d) => d.name)
    .sort();
}

// Calls onEvents with each batch of new complete events after fromOffset. fs.watch
// gives quick updates; polling covers filesystems where it misses changes, and the
// request directory not existing yet. Returns a stop function.
export function tailEvents(
  stateDir: string,
  requestId: RequestId,
  fromOffset: number,
  onEvents: (events: Event[], offset: number) => void,
  opts: { pollMs?: number } = {},
): () => void {
  checkId(requestId, "request id");
  const dir = join(stateDir, "requests", requestId);
  let offset = fromOffset;
  let stopped = false;
  let watcher: FSWatcher | undefined;

  const check = () => {
    if (stopped) return;
    const r = readEventsFrom(stateDir, requestId, offset);
    if (r.offset !== offset) {
      offset = r.offset;
      if (r.events.length > 0) {
        onEvents(r.events, offset);
      }
    }
  };
  const ensureWatcher = () => {
    if (watcher || stopped || !existsSync(dir)) return;
    try {
      watcher = watch(dir, (_type, filename) => {
        if (filename === null || filename === "events.jsonl") check();
      });
      watcher.on("error", () => {
        watcher?.close();
        watcher = undefined;
      });
    } catch {
      watcher = undefined;
    }
  };

  const timer = setInterval(() => {
    ensureWatcher();
    check();
  }, opts.pollMs ?? 1000);
  ensureWatcher();
  setImmediate(check);

  return () => {
    stopped = true;
    clearInterval(timer);
    watcher?.close();
    watcher = undefined;
  };
}
