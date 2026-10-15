import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readCommands } from "../state/commands.ts";
import { appendEvent, eventsPath, type EventInput } from "../state/events.ts";
import { foldEvents } from "../state/fold.ts";
import type { Event } from "../types.ts";
import { appendEventSafe } from "../orchestrator/event-data.ts";
import { StateDirCommandSink, StateDirSource } from "./state-dir.ts";

let stateDir: string;
let source: StateDirSource | undefined;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "ff-state-dir-test-"));
});
afterEach(() => {
  source?.close();
  source = undefined;
  rmSync(stateDir, { recursive: true, force: true });
});

function created(request: string): EventInput {
  return { request, type: "request-created", kind: "burndown", text: `burn down ${request}`, folder: "toolkit/foo" };
}

function start(): StateDirSource {
  source = new StateDirSource(stateDir, { pollMs: 20 });
  source.start();
  return source;
}

// Resolves with the next changed id for which `until` holds.
function nextChange(s: StateDirSource, until: (id: string) => boolean = () => true): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("no change notified"));
    }, 3000);
    const unsubscribe = s.subscribe((id) => {
      if (!until(id)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(id);
    });
  });
}

describe("StateDirSource", () => {
  it("folds the requests already there, synchronously on start", () => {
    appendEvent(stateDir, created("r-a"));
    appendEvent(stateDir, { request: "r-a", type: "step", step: "work list" });
    const s = start();
    assert.deepEqual(
      s.listRequests().map((r) => [r.id, r.step]),
      [["r-a", "work list"]],
    );
    assert.equal(s.getEvents("r-a").length, 2);
    assert.equal(s.getRequest("r-nope"), undefined);
  });

  it("reads an event over 4 KB whole, from its data files, at start and when tailing", async () => {
    appendEventSafe(stateDir, created("r-a"));
    appendEventSafe(stateDir, { request: "r-a", type: "stack", stack: "s", folder: "a", branch: "b", worktree: "/w", order: [], summary: "x".repeat(10_000) });
    const s = start();
    assert.equal(s.getRequest("r-a")?.stacks.s.summary, "x".repeat(10_000));
    const changed = nextChange(s, (id) => s.getRequest(id)?.metaBug !== undefined);
    appendEventSafe(stateDir, { request: "r-a", type: "meta-bug", bug: null, draft: { product: "Testing", component: "General", summary: "meta", description: "y".repeat(10_000) } });
    await changed;
    assert.equal(s.getRequest("r-a")?.metaBug?.draft?.description, "y".repeat(10_000));
  });

  it("sees and notifies events appended after start", async () => {
    appendEvent(stateDir, created("r-a"));
    const s = start();
    const changed = nextChange(s, (id) => s.getRequest(id)?.step === "stack");
    appendEvent(stateDir, { request: "r-a", type: "step", step: "stack" });
    assert.equal(await changed, "r-a");
    assert.equal(s.getEvents("r-a").length, 2);
  });

  it("picks up a request directory that appears later, even before requests/ exists", async () => {
    const s = start();
    assert.deepEqual(s.listRequests(), []);
    const changed = nextChange(s);
    appendEvent(stateDir, created("r-new"));
    assert.equal(await changed, "r-new");
    assert.deepEqual(
      s.listRequests().map((r) => r.id),
      ["r-new"],
    );
  });

  it("ignores request directories with invalid names", () => {
    appendEvent(stateDir, created("r-a"));
    mkdirSync(join(stateDir, "requests", ".hidden"));
    writeFileSync(join(stateDir, "requests", ".hidden", "events.jsonl"), "");
    assert.deepEqual(
      start()
        .listRequests()
        .map((r) => r.id),
      ["r-a"],
    );
  });

  it("drops a request whose directory disappears", async () => {
    appendEvent(stateDir, created("r-a"));
    const s = start();
    const changed = nextChange(s);
    rmSync(join(stateDir, "requests", "r-a"), { recursive: true });
    assert.equal(await changed, "r-a");
    assert.equal(s.getRequest("r-a"), undefined);
    assert.deepEqual(s.listRequests(), []);
  });

  it("waits for a truncated last line to be completed", async () => {
    appendEvent(stateDir, created("r-a"));
    const line = JSON.stringify({ v: 1, t: "2026-10-15T10:00:00Z", request: "r-a", type: "step", step: "stack" }) + "\n";
    appendFileSync(eventsPath(stateDir, "r-a"), line.slice(0, 20));
    const s = start();
    assert.equal(s.getEvents("r-a").length, 1);
    const changed = nextChange(s);
    appendFileSync(eventsPath(stateDir, "r-a"), line.slice(20));
    await changed;
    assert.equal(s.getRequest("r-a")?.step, "stack");
  });

  it("skips a line cut short by a crash and reads what follows", async () => {
    appendEvent(stateDir, created("r-a"));
    appendFileSync(eventsPath(stateDir, "r-a"), '{"v":1,"type":"st');
    const s = start();
    const changed = nextChange(s);
    appendEvent(stateDir, { request: "r-a", type: "step", step: "submit" });
    await changed;
    assert.equal(s.getRequest("r-a")?.step, "submit");
    assert.equal(s.getEvents("r-a").length, 2);
  });

  it("lists a request whose events.jsonl has no complete line yet once it has one", async () => {
    mkdirSync(join(stateDir, "requests", "r-a"), { recursive: true });
    const line = JSON.stringify({ v: 1, t: "2026-10-15T10:00:00Z", request: "r-a", type: "request-created", kind: "burndown", text: "x", folder: "f" }) + "\n";
    appendFileSync(eventsPath(stateDir, "r-a"), line.slice(0, 10));
    const s = start();
    assert.deepEqual(s.listRequests(), []);
    const changed = nextChange(s);
    appendFileSync(eventsPath(stateDir, "r-a"), line.slice(10));
    assert.equal(await changed, "r-a");
    assert.equal(s.listRequests().length, 1);
  });

  it("re-folds a request with 10,000 events quickly", () => {
    const events: Event[] = [{ ...created("r-big"), v: 1, t: "2026-10-15T09:00:00Z" } as Event];
    for (let i = 0; events.length < 10_000; i++) {
      const t = new Date(Date.parse("2026-10-15T09:00:00Z") + i * 1000).toISOString();
      const item = `i${i % 200}`;
      if (i < 200) {
        events.push({ v: 1, t, request: "r-big", type: "item-created", item, folder: "toolkit/foo", group: { message: "timed out", tests: [`test_${i}.js`] } } as Event);
      }
      events.push({ v: 1, t, request: "r-big", type: "job-started", job: `j${i}`, item, kind: "agent", name: "investigate-and-fix", pid: 1000 + i, pidStartTime: i, cmd: ["claude", "-p"], cwd: "/w", codeVersion: "abc" });
      events.push({ v: 1, t, request: "r-big", type: "job-finished", job: `j${i}`, exitCode: 0, durationMs: 1000, costUsd: 0.1 });
      events.push({ v: 1, t, request: "r-big", type: "item-state", item, state: "investigating", detail: `round ${i}` });
    }
    mkdirSync(join(stateDir, "requests", "r-big"), { recursive: true });
    appendFileSync(eventsPath(stateDir, "r-big"), events.map((e) => JSON.stringify(e) + "\n").join(""));
    const t0 = performance.now();
    const s = start();
    const loadMs = performance.now() - t0;
    assert.equal(s.getEvents("r-big").length, events.length);
    const t1 = performance.now();
    const runs = 20;
    for (let i = 0; i < runs; i++) {
      foldEvents(events);
    }
    const foldMs = (performance.now() - t1) / runs;
    process.stderr.write(`# ${events.length} events: read and fold on start ${loadMs.toFixed(1)} ms, re-fold ${foldMs.toFixed(1)} ms\n`);
    // Generous bound; each change re-folds on the server's event loop, blocking page requests meanwhile.
    assert.ok(foldMs < 200, `re-fold took ${foldMs} ms`);
  });
});

describe("StateDirCommandSink", () => {
  it("appends to commands.jsonl with id, v and t", () => {
    new StateDirCommandSink(stateDir).append({ cmd: "presence", visible: true });
    const { commands } = readCommands(stateDir, 0);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].cmd, "presence");
    assert.match(commands[0].id, /^c-/);
    assert.match(readFileSync(join(stateDir, "commands.jsonl"), "utf8"), /"visible":true/);
  });
});
