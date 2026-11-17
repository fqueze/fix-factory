import { test } from "node:test";
import assert from "node:assert/strict";
import type { ItemWorktree } from "./next.ts";
import { pickEvictions, poolRoom } from "./pool.ts";

const w = (name: string, lastUsed: number, idle = true, build: ItemWorktree["build"] = "artifact"): ItemWorktree => ({ name, build, item: `i-${name}`, idle, lastUsed, made: true });

test("the pool's room is what its size and the disk both leave", () => {
  assert.equal(poolRoom(20, 18, 5), 2);
  assert.equal(poolRoom(20, 18, 1), 1);
  assert.equal(poolRoom(20, 25, 5), -5);
});

test("one idle worktree per waiting item, the one unused the longest first, those already picked counting", () => {
  const present = [w("recent", 30), w("old", 10), w("busy", 1, false), w("older", 5)];
  const two = ["artifact", "artifact"] as const;
  assert.deepEqual(pickEvictions(present, new Set(), [...two]), ["older", "old"]);
  assert.deepEqual(pickEvictions(present, new Set(["older"]), [...two]), ["old"], "older is on its way out");
  assert.deepEqual(pickEvictions(present, new Set(["older", "old"]), [...two]), []);
  assert.deepEqual(pickEvictions(present, new Set(), Array(9).fill("artifact")), ["older", "old", "recent"], "never a busy one");
});

test("an opt tree waits for an opt tree to be freed when the 5 are taken, and takes any idle one before", () => {
  const opts = [1, 2, 3, 4, 5].map((n) => w(`opt${n}`, 50 + n, n !== 3, "opt"));
  assert.deepEqual(pickEvictions([w("art", 1), ...opts], new Set(), ["opt"]), ["opt1"], "the 5 are taken: the least used idle opt one");
  assert.deepEqual(pickEvictions([w("art", 1), ...opts.slice(0, 4)], new Set(), ["opt"]), ["art"], "room for an opt tree: any idle one makes room in the pool");
});
