import { test } from "node:test";
import assert from "node:assert/strict";
import type { Dep } from "../../types.ts";
import { orderLandable, orderPatches, type OrderPatch } from "./order.ts";

const hard = (patch: string, needs: string): Dep => ({ patch, needs, kind: "hard", reason: "r", source: "agent" });
const soft = (patch: string, needs: string): Dep => ({ patch, needs, kind: "soft", reason: "r", source: "agent" });
const p = (id: string, effort?: number, value?: number, extra: Partial<OrderPatch> = {}): OrderPatch => ({ id, effort, value, ...extra });

test("easy first, then valuable first", () => {
  const r = orderPatches({ patches: [p("a", 3, 10), p("b", 1, 1), p("c", 3, 50), p("d", 2, 0)], deps: [] });
  assert.deepEqual(r.order, ["b", "d", "c", "a"]);
  assert.deepEqual(r.flippedSoftDeps, []);
});

test("ties are stable: input order", () => {
  const r = orderPatches({ patches: [p("x", 2, 5), p("y", 2, 5), p("z", 2, 5)], deps: [] });
  assert.deepEqual(r.order, ["x", "y", "z"]);
});

test("ties follow the previous order before the input order", () => {
  const r = orderPatches({ patches: [p("x", 2, 5), p("y", 2, 5), p("z", 2, 5)], deps: [], previous: ["z", "x"] });
  assert.deepEqual(r.order, ["z", "x", "y"]);
});

test("test-only first on equal effort and value", () => {
  const r = orderPatches({ patches: [p("prod", 2, 5), p("test", 2, 5, { testOnly: true })], deps: [] });
  assert.deepEqual(r.order, ["test", "prod"]);
});

test("unknown effort goes last, unknown value counts as 0", () => {
  const r = orderPatches({ patches: [p("u"), p("a", 5, 0), p("b", 5)], deps: [] });
  assert.deepEqual(r.order, ["a", "b", "u"]);
});

test("a hard dep is placed just before its first dependent, not at the top", () => {
  // dep is the hardest patch, needed by c (effort 3): it goes right before c, after a and b.
  const r = orderPatches({ patches: [p("dep", 5), p("a", 1), p("b", 2), p("c", 3), p("d", 4)], deps: [hard("c", "dep")] });
  assert.deepEqual(r.order, ["a", "b", "dep", "c", "d"]);
});

test("a dep needed by several patches goes before the first of them", () => {
  const r = orderPatches({ patches: [p("dep", 5), p("a", 1), p("b", 2), p("c", 3)], deps: [hard("c", "dep"), hard("b", "dep")] });
  assert.deepEqual(r.order, ["a", "dep", "b", "c"]);
});

test("chains of hard deps are placed in dependency order", () => {
  const r = orderPatches({ patches: [p("a", 1), p("b", 5), p("c", 4), p("d", 2)], deps: [hard("a", "b"), hard("b", "c")] });
  assert.deepEqual(r.order, ["c", "b", "a", "d"]);
});

test("several deps of one patch keep the rank order among themselves", () => {
  const r = orderPatches({ patches: [p("top", 1), p("x", 4, 1), p("y", 4, 9), p("z", 3)], deps: [hard("top", "x"), hard("top", "y"), hard("top", "z")] });
  assert.deepEqual(r.order, ["z", "y", "x", "top"]);
});

test("a dep already placed earlier isn't moved", () => {
  const r = orderPatches({ patches: [p("a", 1), p("b", 2), p("c", 3)], deps: [hard("c", "a")] });
  assert.deepEqual(r.order, ["a", "b", "c"]);
});

test("hard deps on things outside the stack and soft deps don't constrain the order", () => {
  const r = orderPatches({
    patches: [p("a", 2), p("b", 1)],
    deps: [hard("b", "bug 123 landing first"), soft("b", "a"), hard("a", "not-in-stack")],
  });
  assert.deepEqual(r.order, ["b", "a"]);
});

test("cycles are an error", () => {
  assert.throws(() => orderPatches({ patches: [p("a", 1), p("b", 2), p("c", 3)], deps: [hard("a", "b"), hard("b", "c"), hard("c", "a")] }), /dependency cycle: a -> b -> c -> a/);
  assert.throws(() => orderPatches({ patches: [p("a", 1)], deps: [hard("a", "a")] }), /dependency cycle: a -> a/);
});

test("duplicate ids are an error", () => {
  assert.throws(() => orderPatches({ patches: [p("a", 1), p("a", 2)], deps: [] }), /duplicate/);
});

test("flipped soft deps are reported against the previous order", () => {
  const deps = [soft("a", "b"), soft("c", "d"), soft("a", "new")];
  const r = orderPatches({ patches: [p("a", 1), p("b", 2), p("c", 3), p("d", 4), p("new", 5)], deps, previous: ["b", "a", "c", "d"] });
  assert.deepEqual(r.order, ["a", "b", "c", "d", "new"]);
  assert.deepEqual(r.flippedSoftDeps, [deps[0]]);
});

test("no previous order, no flipped soft deps", () => {
  const r = orderPatches({ patches: [p("a", 2), p("b", 1)], deps: [soft("a", "b")] });
  assert.deepEqual(r.flippedSoftDeps, []);
});

test("landable: accepted with comments addressed and deps met go to the bottom", () => {
  const r = orderLandable({
    patches: [
      p("easy-pending", 1),
      p("ok", 3, 0, { accepted: true, commentsAddressed: true }),
      p("ok-easier", 2, 0, { accepted: true, commentsAddressed: true }),
      p("comments", 1, 0, { accepted: true, commentsAddressed: false }),
    ],
    deps: [],
  });
  assert.deepEqual(r.landable, ["ok-easier", "ok"]);
  assert.deepEqual(r.order, ["ok-easier", "ok", "easy-pending", "comments"]);
});

test("landable: a patch whose hard dep isn't landable stays up, transitively", () => {
  const yes = { accepted: true, commentsAddressed: true };
  const r = orderLandable({
    patches: [p("a", 1, 0, yes), p("b", 1, 0, yes), p("c", 1, 0, yes), p("blocker", 5), p("dep", 4, 0, yes)],
    deps: [hard("a", "blocker"), hard("b", "a"), hard("c", "dep")],
  });
  assert.deepEqual(r.landable, ["dep", "c"]);
  assert.deepEqual(r.order, ["dep", "c", "blocker", "a", "b"]);
});

test("landable: landed deps count as met and landed patches leave the order", () => {
  const yes = { accepted: true, commentsAddressed: true };
  const r = orderLandable({
    patches: [p("gone", 1, 0, { landed: true }), p("a", 2, 0, yes), p("b", 1)],
    deps: [hard("a", "gone")],
  });
  assert.deepEqual(r.landable, ["a"]);
  assert.deepEqual(r.order, ["a", "b"]);
});

test("landable: a hard dep outside the stack blocks landing", () => {
  const r = orderLandable({ patches: [p("a", 1, 0, { accepted: true, commentsAddressed: true })], deps: [hard("a", "harness fix in bug 1")] });
  assert.deepEqual(r.landable, []);
  assert.deepEqual(r.order, ["a"]);
});

test("landable: soft deps flipped by moving patches down are reported", () => {
  const dep = soft("b", "a");
  const r = orderLandable({
    patches: [p("a", 1), p("b", 2, 0, { accepted: true, commentsAddressed: true })],
    deps: [dep],
    previous: ["a", "b"],
  });
  assert.deepEqual(r.order, ["b", "a"]);
  assert.deepEqual(r.flippedSoftDeps, [dep]);
});

test("landable: cycles among landable patches are an error", () => {
  const yes = { accepted: true, commentsAddressed: true };
  assert.throws(() => orderLandable({ patches: [p("a", 1, 0, yes), p("b", 1, 0, yes)], deps: [hard("a", "b"), hard("b", "a")] }), /cycle/);
});
