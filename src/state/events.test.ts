import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { Event } from "../types.ts";
import { appendEvent, eventsPath, listRequests, readEvents, readEventsFrom, tailEvents } from "./events.ts";

const FIXTURE = join(import.meta.dirname, "../../test/fixtures/state/events.jsonl");
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ff-events-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("appendEvent fills v and t and writes one line", () => {
  const e = appendEvent(dir, { type: "note", request: "r1", text: "hello" });
  assert.equal(e.v, 1);
  assert.match(e.t, /^\d{4}-\d\d-\d\dT/);
  const kept = appendEvent(dir, { type: "note", request: "r1", text: "x", t: "2026-01-01T00:00:00.000Z" });
  assert.equal(kept.t, "2026-01-01T00:00:00.000Z");
  const raw = readFileSync(eventsPath(dir, "r1"), "utf8");
  assert.equal(raw.split("\n").length, 3);
  assert.deepEqual(readEvents(dir, "r1"), [e, kept]);
});

test("appendEvent rejects lines over 4 KB", () => {
  assert.throws(() => appendEvent(dir, { type: "note", request: "r1", text: "x".repeat(5000) }), /4096 byte line limit/);
  assert.deepEqual(readEvents(dir, "r1"), []);
});

test("request ids can't escape the state directory", () => {
  assert.throws(() => appendEvent(dir, { type: "note", request: "../x", text: "" }), /invalid request id/);
});

test("readEvents skips a truncated last line and returns [] for a missing request", () => {
  mkdirSync(join(dir, "requests", "r-20261015-xpcshell-cwd"), { recursive: true });
  copyFileSync(FIXTURE, eventsPath(dir, "r-20261015-xpcshell-cwd"));
  const events = readEvents(dir, "r-20261015-xpcshell-cwd");
  assert.equal(events.length, 19);
  assert.equal(events.at(-1)?.type, "note");
  assert.deepEqual(readEvents(dir, "nope"), []);
});

test("appendEvent after a crash-truncated line doesn't lose the new event", () => {
  appendEvent(dir, { type: "note", request: "r1", text: "one" });
  appendFileSync(eventsPath(dir, "r1"), '{"v":1,"type":"no');
  appendEvent(dir, { type: "note", request: "r1", text: "two" });
  assert.deepEqual(
    readEvents(dir, "r1").map((e) => (e as Extract<Event, { type: "note" }>).text),
    ["one", "two"],
  );
});

test("readEventsFrom continues from an offset, including multi-byte text", () => {
  appendEvent(dir, { type: "note", request: "r1", text: "héllo ✓" });
  const a = readEventsFrom(dir, "r1", 0);
  appendEvent(dir, { type: "note", request: "r1", text: "second" });
  const b = readEventsFrom(dir, "r1", a.offset);
  assert.deepEqual(
    b.events.map((e) => (e as Extract<Event, { type: "note" }>).text),
    ["second"],
  );
  assert.equal(readEventsFrom(dir, "r1", b.offset).events.length, 0);
});

test("listRequests lists request directories with an events file", () => {
  assert.deepEqual(listRequests(dir), []);
  appendEvent(dir, { type: "note", request: "r-b", text: "" });
  appendEvent(dir, { type: "note", request: "r-a", text: "" });
  mkdirSync(join(dir, "requests", "empty"));
  assert.deepEqual(listRequests(dir), ["r-a", "r-b"]);
});

function collect(pollMs: number, fromOffset = 0) {
  const got: { events: Event[]; offset: number }[] = [];
  const waiters: (() => void)[] = [];
  const stop = tailEvents(dir, "r1", fromOffset, (events, offset) => {
    got.push({ events, offset });
    waiters.splice(0).forEach((w) => w());
  }, { pollMs });
  const next = (count: number) =>
    new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`timed out waiting for batch ${count}`)), 5000);
      const check = () => {
        if (got.length >= count) {
          clearTimeout(timeout);
          resolve();
        } else {
          waiters.push(check);
        }
      };
      check();
    });
  return { got, stop, next };
}

test("tailEvents starts before the request exists, then delivers each new batch", async () => {
  const t = collect(50);
  try {
    appendEvent(dir, { type: "note", request: "r1", text: "one" });
    await t.next(1);
    assert.deepEqual(
      t.got[0].events.map((e) => (e as Extract<Event, { type: "note" }>).text),
      ["one"],
    );
    appendEvent(dir, { type: "note", request: "r1", text: "two" });
    await t.next(2);
    assert.equal((t.got[1].events[0] as Extract<Event, { type: "note" }>).text, "two");
    assert.equal(t.got[1].offset, readFileSync(eventsPath(dir, "r1")).length);
  } finally {
    t.stop();
  }
});

test("tailEvents picks up appends through fs.watch, not just polling", async () => {
  appendEvent(dir, { type: "note", request: "r1", text: "one" });
  const start = readEventsFrom(dir, "r1", 0).offset;
  const t = collect(60_000, start);
  try {
    await new Promise((r) => setTimeout(r, 50));
    appendEvent(dir, { type: "note", request: "r1", text: "two" });
    await t.next(1);
    assert.equal((t.got[0].events[0] as Extract<Event, { type: "note" }>).text, "two");
  } finally {
    t.stop();
  }
});

test("tailEvents waits for a partial line to be completed", async () => {
  const path = eventsPath(dir, "r1");
  mkdirSync(join(dir, "requests", "r1"), { recursive: true });
  const line = JSON.stringify({ v: 1, t: "2026-10-15T00:00:00Z", request: "r1", type: "note", text: "split" });
  appendFileSync(path, line.slice(0, 20));
  const t = collect(30);
  try {
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(t.got.length, 0);
    appendFileSync(path, line.slice(20) + "\n");
    await t.next(1);
    assert.equal((t.got[0].events[0] as Extract<Event, { type: "note" }>).text, "split");
  } finally {
    t.stop();
  }
});
