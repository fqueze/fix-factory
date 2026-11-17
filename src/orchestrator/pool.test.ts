import { test } from "node:test";
import assert from "node:assert/strict";
import type { ItemWorktree } from "./next.ts";
import { pickEvictions, poolRoom } from "./pool.ts";

const w = (name: string, lastUsed: number, idle = true): ItemWorktree => ({ name, item: `i-${name}`, idle, lastUsed, made: true });

test("the pool's room is what its size and the disk both leave", () => {
  assert.equal(poolRoom(20, 18, 5), 2);
  assert.equal(poolRoom(20, 18, 1), 1);
  assert.equal(poolRoom(20, 25, 5), -5);
});

test("one idle worktree per waiting item, the one unused the longest first, those already picked counting", () => {
  const present = [w("recent", 30), w("old", 10), w("busy", 1, false), w("older", 5)];
  assert.deepEqual(pickEvictions(present, new Set(), 2), ["older", "old"]);
  assert.deepEqual(pickEvictions(present, new Set(["older"]), 2), ["old"], "older is on its way out");
  assert.deepEqual(pickEvictions(present, new Set(["older", "old"]), 2), []);
  assert.deepEqual(pickEvictions(present, new Set(), 9), ["older", "old", "recent"], "never a busy one");
});
