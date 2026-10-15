import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Event } from "../types.ts";
import type { EventInput } from "./events.ts";
import { foldEvents } from "./fold.ts";

const R = "r1";
let clock = 0;
type Input = EventInput extends infer E ? (E extends unknown ? Omit<E, "request"> & { request?: string } : never) : never;
// Builds events with increasing timestamps: minute n of 2026-10-15 09:00.
function ev(e: Input): Event {
  clock++;
  const t = new Date(Date.UTC(2026, 9, 15, 9, clock)).toISOString();
  return { request: R, v: 1, t, ...e } as Event;
}
function fold(...events: Event[]) {
  return foldEvents([ev({ type: "request-created", kind: "burndown", text: "burn down" }), ...events]);
}
const group = { message: "timed out", tests: ["test_a.js"], configs: ["linux"] };

test("empty input throws", () => {
  assert.throws(() => foldEvents([]), /no events/);
});

test("request-created, config, step, updatedAt", () => {
  const created = ev({ type: "request-created", kind: "try-push", text: "fix this push", rev: "abc" });
  const cfg1 = ev({ type: "config-set", config: { a: 1, b: 2 } });
  const cfg2 = ev({ type: "config-set", config: { a: 3 } });
  const step = ev({ type: "step", step: "verify on try" });
  const s = foldEvents([created, cfg1, cfg2, step]);
  assert.equal(s.id, R);
  assert.equal(s.kind, "try-push");
  assert.equal(s.text, "fix this push");
  assert.equal(s.rev, "abc");
  assert.equal("folder" in s, false);
  assert.equal(s.createdAt, created.t);
  assert.equal(s.updatedAt, step.t);
  assert.deepEqual(s.config, { a: 3 });
  assert.equal(s.step, "verify on try");
});

test("request-routed gives a request typed in the main box its kind, folder and revision", () => {
  const created = ev({ type: "request-created", kind: "unrouted", text: "burn down dom/base/test" });
  assert.equal(foldEvents([created]).kind, "unrouted");
  const s = foldEvents([created, ev({ type: "request-routed", kind: "burndown", folder: "dom/base/test" })]);
  assert.equal(s.kind, "burndown");
  assert.equal(s.folder, "dom/base/test");
  assert.equal(s.text, "burn down dom/base/test");
  assert.equal("rev" in s, false);
});

test("unknown event types are ignored, and don't move updatedAt", () => {
  const note = ev({ type: "note", text: "n" });
  const unknown = { request: R, v: 1, t: "2030-01-01T00:00:00.000Z", type: "from-the-future", x: 1 } as unknown as Event;
  const s = fold(note, unknown);
  assert.equal(s.updatedAt, note.t);
  assert.deepEqual(s.notes, [{ t: note.t, text: "n" }]);
});

test("items: created, state changes, detail cleared, unknown items ignored", () => {
  const s = fold(
    ev({ type: "item-created", item: "i1", folder: "f", group }),
    ev({ type: "item-state", item: "i1", state: "investigating", detail: "build 1/2" }),
    ev({ type: "item-state", item: "i1", state: "fix verified locally" }),
    ev({ type: "item-state", item: "nope", state: "blocked" }),
  );
  assert.deepEqual(s.items, { i1: { id: "i1", folder: "f", group, state: "fix verified locally", jobs: [] } });
});

test("jobs: started and finished, linked to their item, last report kept", () => {
  const started = ev({
    type: "job-started",
    job: "j1",
    item: "i1",
    kind: "agent",
    name: "investigate-and-fix",
    pid: 10,
    pidStartTime: 20,
    cmd: ["claude"],
    cwd: "/wt",
    codeVersion: "sha",
    model: "opus",
    sessionId: "s",
  });
  const finished = ev({ type: "job-finished", job: "j1", exitCode: 0, durationMs: 1000, costUsd: 2 });
  const s = fold(
    ev({ type: "item-created", item: "i1", folder: "f", group }),
    started,
    ev({ type: "agent-report", job: "j1", prompt: "investigate-and-fix", report: { state: "left as-is" } }),
    finished,
    ev({ type: "job-started", job: "j2", kind: "script", name: "failures.ts", pid: 11, pidStartTime: 21, cmd: ["node"], cwd: "/", codeVersion: "sha" }),
    ev({ type: "job-finished", job: "unknown", exitCode: 1, durationMs: 1 }),
  );
  assert.deepEqual(s.jobs.j1, {
    job: "j1",
    item: "i1",
    kind: "agent",
    name: "investigate-and-fix",
    cmd: ["claude"],
    cwd: "/wt",
    pid: 10,
    pidStartTime: 20,
    startedAt: started.t,
    endedAt: finished.t,
    exitCode: 0,
    durationMs: 1000,
    costUsd: 2,
    model: "opus",
    sessionId: "s",
  });
  assert.equal(s.jobs.j2.endedAt, undefined);
  assert.deepEqual(s.items.i1.jobs, ["j1"]);
  assert.deepEqual(s.items.i1.lastReport, { prompt: "investigate-and-fix", report: { state: "left as-is" }, job: "j1" });
  assert.equal(s.jobs.unknown, undefined);
});

test("patches: the latest event per id wins, deps and review survive rewrites", () => {
  const s = fold(
    ev({ type: "patch", patch: "p1", sha: "a", worktree: "/wt", title: "Bug XXXXXXX - x", bug: null, bugDraft: { product: "P", component: "C", summary: "s", description: "d" } }),
    ev({ type: "dep", dep: { patch: "p1", needs: "p0", kind: "hard", reason: "r", source: "agent" } }),
    ev({ type: "review-status", patch: "p1", revision: 5, status: "needs-review", reviewers: [{ name: "a", status: "pending" }], comments: [] }),
    ev({ type: "patch", patch: "p1", sha: "b", worktree: "/wt", title: "Bug 1 - x", bug: 1, revision: 5 }),
    ev({ type: "patch", patch: "p2", sha: "c", worktree: "/wt", title: "Bug 2 - y", bug: 2 }),
  );
  assert.deepEqual(s.patches.p1, {
    id: "p1",
    sha: "b",
    worktree: "/wt",
    title: "Bug 1 - x",
    bug: 1,
    revision: 5,
    deps: [{ patch: "p1", needs: "p0", kind: "hard", reason: "r", source: "agent" }],
    review: { revision: 5, status: "needs-review", reviewers: [{ name: "a", status: "pending" }], comments: [] },
    replyDrafts: [],
  });
  assert.deepEqual(Object.keys(s.patches), ["p1", "p2"]);
});

test("deps: added before the patch exists, replaced by needs, removed", () => {
  const dep = (needs: string, kind: "hard" | "soft", reason = "r") => ev({ type: "dep", dep: { patch: "p1", needs, kind, reason, source: "textual" } });
  const s = fold(
    dep("p0", "soft"),
    dep("outside thing", "hard"),
    ev({ type: "patch", patch: "p1", sha: "a", worktree: "/wt", title: "t", bug: 1 }),
    dep("p0", "hard", "upgraded"),
    dep("p9", "soft"),
    ev({ type: "dep-removed", patch: "p1", needs: "p9" }),
    ev({ type: "dep-removed", patch: "nope", needs: "p9" }),
  );
  assert.deepEqual(
    s.patches.p1.deps.map((d) => [d.needs, d.kind, d.reason]),
    [
      ["outside thing", "hard", "r"],
      ["p0", "hard", "upgraded"],
    ],
  );
});

test("review status: latest wins; reply drafts replaced by comment id", () => {
  const comment = { id: 7, author: "a", text: "why?", done: false };
  const s = fold(
    ev({ type: "patch", patch: "p1", sha: "a", worktree: "/wt", title: "t", bug: 1 }),
    ev({ type: "review-status", patch: "p1", revision: 5, status: "needs-review", reviewers: [], comments: [] }),
    ev({ type: "review-status", patch: "p1", revision: 5, status: "needs-revision", reviewers: [{ name: "a", status: "blocking" }], comments: [comment] }),
    ev({ type: "reply-draft", patch: "p1", commentId: 7, text: "first" }),
    ev({ type: "reply-draft", patch: "p1", commentId: 8, text: "other" }),
    ev({ type: "reply-draft", patch: "p1", commentId: 7, text: "second" }),
  );
  assert.equal(s.patches.p1.review?.status, "needs-revision");
  assert.deepEqual(s.patches.p1.review?.comments, [comment]);
  assert.deepEqual(s.patches.p1.replyDrafts, [
    { commentId: 7, text: "second" },
    { commentId: 8, text: "other" },
  ]);
});

test("stacks: latest event per stack wins", () => {
  const s = fold(
    ev({ type: "stack", stack: "s1", folder: "f", branch: "b", worktree: "/wt", order: ["p1", "p2"] }),
    ev({ type: "stack", stack: "s1", folder: "f", branch: "b", worktree: "/wt", order: ["p2", "p1"], summary: "sum" }),
  );
  assert.deepEqual(s.stacks, { s1: { id: "s1", folder: "f", branch: "b", worktree: "/wt", order: ["p2", "p1"], summary: "sum" } });
});

test("pushes: creation order, progress, result, stubs for unplanned pushes", () => {
  const s = fold(
    ev({ type: "try-planned", push: "push-b", purpose: "product code", command: ["mach", "try"], taskCount: 10 }),
    ev({ type: "try-planned", push: "push-a", purpose: "tests", command: ["mach", "try", "x"] }),
    ev({ type: "try-pushed", push: "push-b", rev: "r1", url: "u1" }),
    ev({ type: "try-progress", push: "push-b", done: 3, total: 10, failures: 1 }),
    ev({ type: "try-progress", push: "push-b", done: 10, total: 10, failures: 2 }),
    ev({ type: "try-finished", push: "push-b", result: "failures", summary: "2 failures" }),
    ev({ type: "try-pushed", push: "existing", rev: "r0", url: "u0" }),
    ev({ type: "try-planned", push: "push-b", purpose: "product code, replanned", command: ["mach", "try"], taskCount: 10 }),
  );
  assert.deepEqual(Object.keys(s.pushes), ["push-b", "push-a", "existing"]);
  assert.deepEqual(s.pushes["push-b"], {
    id: "push-b",
    purpose: "product code, replanned",
    command: ["mach", "try"],
    taskCount: 10,
    rev: "r1",
    url: "u1",
    progress: { done: 10, total: 10, failures: 2 },
    result: "failures",
    summary: "2 failures",
  });
  assert.deepEqual(s.pushes.existing, { id: "existing", purpose: "", command: [], rev: "r0", url: "u0" });
});

test("needs-user: opened and cleared by key, re-raising keeps since", () => {
  const first = ev({ type: "needs-user", key: "k1", action: "approve", detail: "d1", push: "push-1" });
  const s = fold(
    first,
    ev({ type: "needs-user", key: "k2", action: "file bug", detail: "d2", patch: "p1" }),
    ev({ type: "needs-user", key: "k1", action: "approve", detail: "d1 updated", push: "push-1" }),
    ev({ type: "user-done", key: "k2" }),
    ev({ type: "user-done", key: "never-opened" }),
  );
  assert.deepEqual(s.needsUser, [{ key: "k1", action: "approve", detail: "d1 updated", push: "push-1", since: first.t }]);
});

test("recovery plans and notes accumulate; command-executed changes nothing else", () => {
  const plan = ev({ type: "recovery-plan", job: "j9", text: "lando was down", plan: [{ cmd: "retry-job", job: "j1", reason: "lando" }], cannotDo: [], questions: ["sure?"] });
  const done = ev({ type: "command-executed", command: "c1", ok: true });
  const s = fold(plan, ev({ type: "note", text: "a" }), ev({ type: "note", text: "b" }), done);
  assert.deepEqual(s.recoveryPlans, [{ job: "j9", text: "lando was down", plan: [{ cmd: "retry-job", job: "j1", reason: "lando" }], cannotDo: [], questions: ["sure?"], t: plan.t }]);
  assert.deepEqual(
    s.notes.map((n) => n.text),
    ["a", "b"],
  );
  assert.equal(s.updatedAt, done.t);
});

test("doesn't mutate its input, and the result shares no objects with it", () => {
  const events = [
    ev({ type: "request-created", kind: "burndown", text: "x" }),
    ev({ type: "item-created", item: "i1", folder: "f", group: { message: "m", tests: ["t"], configs: [] } }),
    ev({ type: "stack", stack: "s1", folder: "f", branch: "b", worktree: "/wt", order: ["p1"] }),
  ];
  const before = structuredClone(events);
  const s = foldEvents(events);
  s.items.i1.group.tests.push("t2");
  s.stacks.s1.order.push("p2");
  assert.deepEqual(events, before);
});

test("folds the fixture request (truncated last line excluded)", () => {
  const raw = readFileSync(join(import.meta.dirname, "../../test/fixtures/state/events.jsonl"), "utf8");
  const events = raw
    .split("\n")
    .slice(0, -1)
    .map((l) => JSON.parse(l) as Event);
  const s = foldEvents(events);
  assert.equal(s.id, "r-20261015-xpcshell-cwd");
  assert.equal(s.folder, "toolkit/foo");
  assert.equal(s.step, "work list");
  assert.equal(s.items.i1.state, "reviewed");
  assert.equal(s.patches.p1.sha, "bbb");
  assert.equal(s.patches.p1.bug, 2081216);
  assert.equal(s.patches.p1.bugDraft, undefined);
  assert.deepEqual(s.needsUser, []);
  assert.equal(s.pushes["push-1"].result, "green");
  assert.equal(s.jobs.j1.costUsd, 3.5);
  assert.equal(s.updatedAt, "2026-10-15T11:01:00.000Z");
  assert.equal(JSON.stringify(JSON.parse(JSON.stringify(s))), JSON.stringify(s));
});

test("meta bug, stack base, interdiff and needs-user stack/job fields", () => {
  const s = fold(
    ev({ type: "meta-bug", bug: null, draft: { product: "Testing", component: "General", summary: "[meta] x", description: "d" } }),
    ev({ type: "meta-bug", bug: 2081216 }),
    ev({ type: "stack", stack: "st", folder: "f", branch: "b", worktree: "/w", base: "abc", order: [] }),
    ev({ type: "patch", patch: "p", sha: "1", worktree: "/w", title: "t", bug: null, interdiffFile: "cache/interdiff/p.diff" }),
    ev({ type: "needs-user", key: "submit:st", action: "Submit", detail: "", stack: "st", job: "j1" }),
  );
  assert.deepEqual(s.metaBug, { bug: 2081216 });
  assert.equal(s.stacks.st.base, "abc");
  assert.equal(s.patches.p.interdiffFile, "cache/interdiff/p.diff");
  assert.equal(s.needsUser[0].stack, "st");
  assert.equal(s.needsUser[0].job, "j1");
});
