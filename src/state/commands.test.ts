import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
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

test("appendCommand rejects lines over 4 KB", () => {
  assert.throws(() => appendCommand(dir, { cmd: "tell-factory", text: "x".repeat(5000) }), /line limit/);
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
