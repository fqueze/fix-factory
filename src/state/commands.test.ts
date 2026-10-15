import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { Command } from "../types.ts";
import { appendCommand, commandsPath, loadCursor, processNewCommands, readCommands, saveCursor } from "./commands.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ff-commands-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("appendCommand fills id, v and t", () => {
  const a = appendCommand(dir, { cmd: "start-now", request: "r1" });
  const b = appendCommand(dir, { cmd: "approve-push", request: "r1", push: "push-1" });
  assert.equal(a.v, 1);
  assert.match(a.t, /^\d{4}-/);
  assert.match(a.id, /^c-\d{8}-\d{6}-[0-9a-f]{8}$/);
  assert.notEqual(a.id, b.id);
  assert.deepEqual(readCommands(dir, 0).commands, [a, b]);
});

test("texts over 2 KB go to commands-data and come back on read", () => {
  const long = "é".repeat(3000);
  const a = appendCommand(dir, { cmd: "tell-factory", text: long, id: "c1" });
  const b = appendCommand(dir, { cmd: "stack-comments", stack: "s1", id: "c2", comments: [{ patch: "p1", text: "short" }, { patch: "p2", text: long }] });
  const raw = readFileSync(commandsPath(dir), "utf8");
  assert.ok(raw.length < 1000);
  assert.match(raw, /"text":\{"textFile":"commands-data\/c1\.1\.txt"\}/);
  assert.equal(readFileSync(join(dir, "commands-data", "c1.1.txt"), "utf8"), long);
  assert.equal(readFileSync(join(dir, "commands-data", "c2.1.txt"), "utf8"), long);
  assert.deepEqual(readCommands(dir, 0).commands, [a, b]);
});

test("strings under 2 KB are moved too, largest first, until the line fits", () => {
  const comments = [1900, 2000, 1950].map((n, i) => ({ patch: `p${i}`, text: String(i).repeat(n) }));
  const c = appendCommand(dir, { cmd: "stack-comments", stack: "s1", id: "c1", comments });
  assert.ok(readFileSync(commandsPath(dir)).length <= 4096);
  // Moving the 2000 byte text is enough.
  assert.deepEqual(readdirSync(join(dir, "commands-data")), ["c1.1.txt"]);
  assert.equal(readFileSync(join(dir, "commands-data", "c1.1.txt"), "utf8"), comments[1].text);
  assert.match(readFileSync(commandsPath(dir), "utf8"), /"text":"0{1900}".*"text":"2{1950}"/);
  assert.deepEqual(readCommands(dir, 0).commands, [c]);
});

test("command keys never end up in file names", () => {
  const c = appendCommand(dir, { cmd: "edit-config", id: "c1", reason: "r", config: { "/../../../escaped": "x".repeat(3000) } });
  assert.deepEqual(readdirSync(join(dir, "commands-data")), ["c1.1.txt"]);
  assert.deepEqual(readCommands(dir, 0).commands, [c]);
});

test("a textFile reference outside commands-data is refused", () => {
  appendFileSync(commandsPath(dir), JSON.stringify({ v: 1, id: "c1", t: "x", cmd: "tell-factory", text: { textFile: "../secret.txt" } }) + "\n");
  assert.throws(() => readCommands(dir, 0), /outside commands-data/);
});

test("appendCommand still rejects lines over 4 KB made of short strings", () => {
  const comments = Array.from({ length: 100 }, (_, i) => ({ patch: `p${i}`, text: "x".repeat(50) }));
  assert.throws(() => appendCommand(dir, { cmd: "stack-comments", stack: "s1", comments }), /line limit/);
});

test("readCommands returns the new offset and ignores a partial last line", () => {
  assert.deepEqual(readCommands(dir, 0), { commands: [], offset: 0 });
  appendCommand(dir, { cmd: "start-now" });
  const first = readCommands(dir, 0);
  assert.equal(first.commands.length, 1);
  appendFileSync(commandsPath(dir), '{"v":1,"id":"c-x","cmd":"sta');
  const second = readCommands(dir, first.offset);
  assert.deepEqual(second, { commands: [], offset: first.offset });
  appendFileSync(commandsPath(dir), 'rt-now","t":"2026-10-15T00:00:00Z"}\n');
  assert.equal(readCommands(dir, first.offset).commands[0].id, "c-x");
});

test("cursor defaults to 0 and persists", () => {
  assert.equal(loadCursor(dir), 0);
  saveCursor(dir, 123);
  assert.equal(loadCursor(dir), 123);
});

test("processNewCommands executes each command once across restarts", async () => {
  const seen: string[] = [];
  const run = (c: Command) => {
    seen.push(c.id);
  };
  appendCommand(dir, { cmd: "start-now", id: "c1" });
  appendCommand(dir, { cmd: "start-now", id: "c2" });
  assert.equal(await processNewCommands(dir, run), 2);
  assert.equal(await processNewCommands(dir, run), 0);
  appendCommand(dir, { cmd: "start-now", id: "c3" });
  assert.equal(await processNewCommands(dir, run), 1);
  assert.deepEqual(seen, ["c1", "c2", "c3"]);
});

test("overlapping processNewCommands calls don't run a command twice", async () => {
  appendCommand(dir, { cmd: "start-now", id: "c1" });
  appendCommand(dir, { cmd: "start-now", id: "c2" });
  const seen: string[] = [];
  const slow = async (c: Command) => {
    await new Promise((r) => setTimeout(r, 20));
    seen.push(c.id);
  };
  const counts = await Promise.all([processNewCommands(dir, slow), processNewCommands(dir, slow), processNewCommands(dir, slow)]);
  assert.deepEqual(counts, [2, 0, 0]);
  assert.deepEqual(seen, ["c1", "c2"]);
});

test("processNewCommands keeps the cursor before a command that throws", async () => {
  appendCommand(dir, { cmd: "start-now", id: "c1" });
  appendCommand(dir, { cmd: "start-now", id: "c2" });
  const seen: string[] = [];
  await assert.rejects(
    processNewCommands(dir, (c) => {
      if (c.id === "c2") throw new Error("boom");
      seen.push(c.id);
    }),
    /boom/,
  );
  await processNewCommands(dir, (c) => {
    seen.push(c.id);
  });
  assert.deepEqual(seen, ["c1", "c2"]);
});
