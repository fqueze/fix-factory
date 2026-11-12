import type { Dep, PatchId } from "../../types.ts";

// Stack ordering: pure functions, no git.
//
// Rule: test-only fixes before those changing product code, then easy first (effort ascending; a fix's patches by
// the hardest of them), then valuable first (value = failures/week, descending), then
// test-only first, then the previous order, then the input order. Each patch comes after its hard
// deps, and a dep is pulled in just before its first dependent rather than going to the top: we walk
// the patches in rank order and, before placing one, place its not-yet-placed hard deps (themselves
// in rank order, recursively). Hard deps on something that isn't a patch of the input (free text, or
// a patch outside the stack) don't constrain the order. Soft deps never do; they are only reported
// when the new order flips them relative to the previous one.
//
// Landable patches (accepted, comments addressed, every hard dep landed or itself landable) come first, at the
// bottom, ranked among themselves by the same rule: moving them down keeps every other patch's order. Landed patches
// leave the order.

export interface OrderPatch {
  id: PatchId;
  effort?: number; // 1-5; unknown efforts go last
  value?: number; // failures/week; unknown counts as 0
  testOnly?: boolean;
  fix?: string; // the fix it's a patch of: one fix's patches stay together
  // On Phabricator:
  accepted?: boolean;
  commentsAddressed?: boolean;
  landed?: boolean;
  published?: boolean; // landed, still in the stack until its base has it: first of all
}

export interface OrderInput {
  patches: OrderPatch[];
  deps: Dep[];
  previous?: PatchId[];
}

export interface OrderOutput {
  order: PatchId[];
  flippedSoftDeps: Dep[];
  landable: PatchId[]; // the bottom of `order` that can land now
  metDeps?: Dep[]; // hard deps on a commit outside the stack that the base already has (stack.ts order --cwd --base)
}

function rankComparator(patches: OrderPatch[], previous: PatchId[] | undefined, landable: Set<PatchId>): (a: OrderPatch, b: OrderPatch) => number {
  const inputIndex = new Map(patches.map((p, i) => [p.id, i]));
  const prevIndex = new Map((previous ?? []).map((id, i) => [id, i]));
  // A fix takes the attention of its hardest patch: its easy test patch doesn't bring its product patch among the easy
  // ones.
  const fixEffort = new Map<string, number>();
  for (const p of patches) if (p.fix !== undefined) fixEffort.set(`${p.fix}\n${landable.has(p.id)}`, Math.max(fixEffort.get(`${p.fix}\n${landable.has(p.id)}`) ?? -Infinity, p.effort ?? Infinity));
  const effort = (p: OrderPatch) => (p.fix === undefined ? p.effort ?? Infinity : fixEffort.get(`${p.fix}\n${landable.has(p.id)}`)!);
  // Test-only fixes before those that change product code: a fix with a product patch is a product fix.
  const product = new Set(patches.filter((p) => !p.testOnly).map((p) => p.fix ?? p.id));
  const isProduct = (p: OrderPatch) => Number(product.has(p.fix ?? p.id));
  return (a, b) =>
    Number(!!b.published) - Number(!!a.published) ||
    Number(landable.has(b.id)) - Number(landable.has(a.id)) ||
    isProduct(a) - isProduct(b) ||
    effort(a) - effort(b) ||
    (b.value ?? 0) - (a.value ?? 0) ||
    Number(!!b.testOnly) - Number(!!a.testOnly) ||
    (prevIndex.get(a.id) ?? Infinity) - (prevIndex.get(b.id) ?? Infinity) ||
    inputIndex.get(a.id)! - inputIndex.get(b.id)!;
}

function checkIds(patches: OrderPatch[]): void {
  const seen = new Set<PatchId>();
  for (const p of patches) {
    if (seen.has(p.id)) throw new Error(`duplicate patch id ${p.id}`);
    seen.add(p.id);
  }
}

// Orders `subset` (patches of `all`), honouring the hard deps between patches of the subset.
function placeWithDeps(subset: OrderPatch[], deps: Dep[], compare: (a: OrderPatch, b: OrderPatch) => number): PatchId[] {
  const byId = new Map(subset.map((p) => [p.id, p]));
  const needs = new Map<PatchId, OrderPatch[]>();
  for (const d of deps) {
    if (d.kind !== "hard" || !byId.has(d.patch) || !byId.has(d.needs)) continue;
    const list = needs.get(d.patch) ?? [];
    if (!list.includes(byId.get(d.needs)!)) list.push(byId.get(d.needs)!);
    needs.set(d.patch, list);
  }
  const order: PatchId[] = [];
  const done = new Set<PatchId>();
  const path: PatchId[] = [];
  const place = (p: OrderPatch): void => {
    if (done.has(p.id)) return;
    const at = path.indexOf(p.id);
    if (at >= 0) {
      throw new Error(`dependency cycle: ${[...path.slice(at), p.id].join(" -> ")}`);
    }
    path.push(p.id);
    for (const dep of [...(needs.get(p.id) ?? [])].sort(compare)) place(dep);
    path.pop();
    done.add(p.id);
    order.push(p.id);
  };
  for (const p of [...subset].sort(compare)) place(p);
  return order;
}

export function flippedSoftDeps(deps: Dep[], order: PatchId[], previous: PatchId[] | undefined): Dep[] {
  if (!previous) return [];
  const now = new Map(order.map((id, i) => [id, i]));
  const before = new Map(previous.map((id, i) => [id, i]));
  return deps.filter((d) => {
    if (d.kind !== "soft") return false;
    const [a, b, pa, pb] = [now.get(d.patch), now.get(d.needs), before.get(d.patch), before.get(d.needs)];
    if (a === undefined || b === undefined || pa === undefined || pb === undefined) return false;
    return a < b !== pa < pb;
  });
}

// A hard dep on something outside the input (free text) blocks landing: nothing tells us it landed, so it must be
// removed from the deps once it has.
function landableOf(input: OrderInput): Set<PatchId> {
  const ids = new Set(input.patches.map((p) => p.id));
  const landed = new Set(input.patches.filter((p) => p.landed).map((p) => p.id));
  const landable = new Set(input.patches.filter((p) => !p.landed && p.accepted && p.commentsAddressed).map((p) => p.id));
  const hard = input.deps.filter((d) => d.kind === "hard");
  let changed = true;
  while (changed) {
    changed = false;
    for (const d of hard) {
      if (!landable.has(d.patch)) continue;
      const met = ids.has(d.needs) ? landed.has(d.needs) || landable.has(d.needs) : false;
      if (!met) {
        landable.delete(d.patch);
        changed = true;
      }
    }
  }
  return landable;
}

export function orderPatches(input: OrderInput): OrderOutput {
  checkIds(input.patches);
  const landable = landableOf(input);
  const order = placeWithDeps(
    input.patches.filter((p) => !p.landed),
    input.deps,
    rankComparator(input.patches, input.previous, landable),
  );
  const together = keepFixesTogether(order, input.patches, input.deps, landable);
  return { order: together, flippedSoftDeps: flippedSoftDeps(input.deps, together, input.previous), landable: together.filter((id) => landable.has(id)) };
}

// One fix's patches next to each other, where its first one is, in their order: those landable apart from those that
// aren't, which come later.
// A patch is only pulled forward once the patches it needs (hard deps) are placed.
function keepFixesTogether(order: PatchId[], patches: OrderPatch[], deps: Dep[], landable: Set<PatchId>): PatchId[] {
  const fixOf = new Map(patches.map((p) => [p.id, p.fix]));
  const group = (id: PatchId) => (fixOf.get(id) === undefined ? id : `${fixOf.get(id)}\n${landable.has(id)}`);
  const needs = (id: PatchId) => deps.filter((d) => d.kind === "hard" && d.patch === id && order.includes(d.needs)).map((d) => d.needs);
  const out: PatchId[] = [];
  for (const id of order) {
    if (out.includes(id)) continue;
    out.push(id);
    for (const x of order) if (x !== id && !out.includes(x) && group(x) === group(id) && needs(x).every((n) => out.includes(n))) out.push(x);
  }
  return out;
}
