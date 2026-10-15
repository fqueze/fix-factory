// Events over the 4 KB line limit (docs/CONTRACTS.md): their biggest values move to files under
// requests/<id>/event-data/, and the line holds {"dataFile": "<path relative to stateDir>"} in their
// place, largest first until it fits. internalizeEvent puts them back. Any event payload can grow
// (review comments, a stack summary, a bug draft, a recovery plan), so every event the orchestrator
// writes goes through here. Readers of events.jsonl must internalize: src/state/events.ts should do it in
// readEventsFrom, for the server and anyone else.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appendEvent, readEvents, type EventInput } from "../state/events.ts";
import { MAX_LINE_BYTES, writeFileAtomic } from "../state/jsonl.ts";
import type { Event, RequestId } from "../types.ts";

// Kept inline: what readers route and filter on.
const ENVELOPE_KEYS = new Set(["v", "t", "request", "type"]);
const DATA_FILE = /^requests\/[A-Za-z0-9][A-Za-z0-9._-]*\/event-data\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;

export function appendEventSafe(stateDir: string, event: EventInput): Event {
  const full = { ...event, v: event.v ?? 1, t: event.t ?? new Date().toISOString() } as Event;
  const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v)) + 1;
  if (size(full) <= MAX_LINE_BYTES) return appendEvent(stateDir, full);
  const copy = structuredClone(full) as unknown as Record<string, unknown>;
  const candidates: { holder: Record<string | number, unknown>; key: string | number; bytes: number }[] = [];
  const collect = (holder: Record<string | number, unknown>, top: boolean) => {
    for (const key of Object.keys(holder)) {
      if (top && ENVELOPE_KEYS.has(key)) continue;
      const v = holder[key];
      if (typeof v === "string" || (v !== null && typeof v === "object")) candidates.push({ holder, key, bytes: size(v) });
      if (v !== null && typeof v === "object") collect(v as Record<string | number, unknown>, false);
    }
  };
  collect(copy, true);
  candidates.sort((a, b) => b.bytes - a.bytes);
  const prefix = `${full.t.replace(/[-:.]/g, "")}-${randomBytes(3).toString("hex")}`;
  let n = 0;
  for (const c of candidates) {
    if (size(copy) <= MAX_LINE_BYTES) break;
    // Smaller than its reference: moving it can't help.
    if (c.bytes < 80) break;
    const dataFile = `requests/${full.request}/event-data/${prefix}.${++n}.json`;
    mkdirSync(join(stateDir, "requests", full.request, "event-data"), { recursive: true });
    // Written before the line, so a reader never finds a reference to a missing file.
    writeFileAtomic(join(stateDir, dataFile), JSON.stringify(c.holder[c.key]));
    c.holder[c.key] = { dataFile };
  }
  return appendEvent(stateDir, copy as unknown as Event);
}

export function internalizeEvent<T>(stateDir: string, value: T): T {
  if (Array.isArray(value)) return value.map((v) => internalizeEvent(stateDir, v)) as T;
  if (value !== null && typeof value === "object") {
    const dataFile = (value as { dataFile?: unknown }).dataFile;
    if (typeof dataFile === "string" && Object.keys(value).length === 1) {
      if (!DATA_FILE.test(dataFile)) throw new Error(`event data file outside event-data: ${JSON.stringify(dataFile)}`);
      return internalizeEvent(stateDir, JSON.parse(readFileSync(join(stateDir, dataFile), "utf8")));
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, internalizeEvent(stateDir, v)])) as T;
  }
  return value;
}

export function readFullEvents(stateDir: string, request: RequestId): Event[] {
  return readEvents(stateDir, request).map((e) => internalizeEvent(stateDir, e));
}
