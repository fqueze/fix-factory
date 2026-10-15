// Events over the 4 KB line limit (docs/CONTRACTS.md): their biggest values move to files under
// requests/<id>/event-data/, and the line holds {"dataFile": "<path relative to stateDir>"} in their
// place, largest first until it fits; readEventsFrom (src/state/events.ts) puts them back. Any event
// payload can grow (review comments, a stack summary, a bug draft, a recovery plan), so every event
// the orchestrator writes goes through here.
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { appendEvent, type EventInput } from "../state/events.ts";
import { MAX_LINE_BYTES, writeFileAtomic } from "../state/jsonl.ts";
import type { Event } from "../types.ts";

// Kept inline: what readers route and filter on.
const ENVELOPE_KEYS = new Set(["v", "t", "request", "type"]);

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
