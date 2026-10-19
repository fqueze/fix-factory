import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Command, PlannedCommand } from "../types.ts";
import { commandEffects, newRequestId, type Effect } from "./commands.ts";
import { config, ID, Scenario, sha } from "./testkit.ts";

let n = 0;
const cmd = (c: Record<string, unknown>): Command => ({ v: 1, id: `c-${++n}`, t: "2026-10-15T09:00:00.000Z", request: ID, ...c }) as Command;

function run(sc: Scenario, c: Command): Effect[] {
  const effects = commandEffects(c, { config, state: sc.state(), view: sc.view(), exists: () => false, plan: (job) => sc.plans.get(job) });
  for (const e of effects) {
    if (e.type === "event") sc.add(e.event);
    if (e.type === "start") sc.startJob(e.plan);
  }
  return effects;
}

// A try-push request whose item i-a has a patch p-a from its investigate-and-fix run.
function withPatch(): Scenario {
  const sc = new Scenario("try-push", { rev: "abc" });
  sc.add({ type: "item-created", request: ID, item: "i-a", folder: "a", group: { message: "boom", tests: ["a/test_a.js"], configs: ["linux"] } });
  sc.startJob({ purpose: { key: "author:i-a:initial", what: "author", item: "i-a", reason: "initial" }, kind: "agent", name: "investigate-and-fix", item: "i-a", cwd: "/wt/a", agent: { sessionId: "s-1", resume: false, vars: { test: "a/test_a.js", worktree: "/wt/a", failureSummary: "boom" } } });
  sc.complete("author:i-a:initial", { report: { state: "fix verified locally", summary: "s", cause: "c", verification: "v", commits: [sha("1")], landsAfter: [], feedback: [] } });
  sc.add({ type: "patch", request: ID, patch: "p-a", item: "i-a", sha: sha("1"), worktree: "/wt/a", title: "Bug XXXXXXX - Fix", bug: null, bugDraft: { product: "Core", component: "DOM", summary: "s", description: "d" } });
  return sc;
}

const executed = (sc: Scenario) => sc.of("command-executed").map((e) => ({ ok: e.ok, detail: e.detail }));

describe("commands", () => {
  it("names a new request from the first words of its text", () => {
    const t = "2026-10-15T09:00:00.000Z";
    assert.equal(newRequestId({ t, text: "Fix the xpcshell cwd failures" }, () => false), "r-20261015-fix-the-xpcshell-cwd");
    assert.equal(newRequestId({ t, text: "a b" }, (id) => id === "r-20261015-a-b"), "r-20261015-a-b-2");
    assert.equal(newRequestId({ t, text: "!!!" }, () => false), "r-20261015-request");
  });

  it("decline-push declines a push waiting for you, with your reason", () => {
    const sc = withPatch();
    sc.add({ type: "needs-user", request: ID, key: "approve-push:A", action: "Approve", detail: "", push: "A" });
    run(sc, cmd({ cmd: "decline-push", push: "A", text: "too many rebuilds" }));
    assert.equal(sc.state().pushes.A.declined, "too many rebuilds");
    assert.deepEqual(sc.open(), []);
    run(sc, cmd({ cmd: "decline-push", push: "A", text: "again" }));
    assert.deepEqual(executed(sc).map((e) => e.ok), [true, false]);
  });

  it("approve-push, take-it and hand-back answer their needs-user", () => {
    const sc = withPatch();
    run(sc, cmd({ cmd: "approve-push", push: "A" }));
    run(sc, cmd({ cmd: "take-it", item: "i-a" }));
    assert.deepEqual(sc.of("user-done").map((e) => e.key), ["approve-push:A", "take-it:i-a"]);
    run(sc, cmd({ cmd: "hand-back", item: "i-a" }));
    assert.equal(sc.state().items["i-a"].state, "handed back");
    assert.ok(executed(sc).every((e) => e.ok));
  });

  it("set-bug sets a patch's bug, or the meta bug", () => {
    const sc = withPatch();
    sc.add({ type: "needs-user", request: ID, key: "file-bug:p-a:meta-bug-step", action: "File", detail: "", patch: "p-a" });
    sc.add({ type: "meta-bug", request: ID, bug: null, draft: { product: "Testing", component: "General", summary: "meta", description: "d" } });
    sc.add({ type: "needs-user", request: ID, key: "meta-bug:a", action: "File the meta bug", detail: "", stack: "a" });
    run(sc, cmd({ cmd: "set-bug", patch: "p-a", bug: 2081216 }));
    run(sc, cmd({ cmd: "set-bug", patch: "meta", bug: 2081200 }));
    const s = sc.state();
    assert.equal(s.patches["p-a"].bug, 2081216);
    assert.equal(s.patches["p-a"].title, "Bug XXXXXXX - Fix");
    assert.equal(s.metaBug?.bug, 2081200);
    assert.equal(s.metaBug?.draft?.summary, "meta");
    assert.deepEqual(s.needsUser, []);
  });

  it("comment-bug-draft revises the draft with Sonnet, and the result replaces it", () => {
    const sc = withPatch();
    const c = cmd({ cmd: "comment-bug-draft", patch: "p-a", text: "it's in DOM: Events" });
    run(sc, c);
    const key = `revise-draft:p-a:${c.id}`;
    assert.equal(sc.plan(key).name, "revise-bug-draft");
    assert.equal(sc.plan(key).agent?.vars?.comments, "it's in DOM: Events");
    sc.complete(key, { report: { draft: { product: "Core", component: "DOM: Events", summary: "s", description: "d" }, feedback: [] } });
    assert.equal(sc.state().patches["p-a"].bugDraft?.component, "DOM: Events");
  });

  it("comment-fix and stack-comments resume the patch's author, unless it's running", () => {
    const sc = withPatch();
    const c = cmd({ cmd: "comment-fix", patch: "p-a", text: "drop the timeout" });
    run(sc, c);
    const plan = sc.plan(`author:i-a:comment:${c.id}`);
    assert.equal(plan.agent?.sessionId, "s-1");
    assert.equal(plan.agent?.resume, true);
    assert.match(plan.agent?.message ?? "", /drop the timeout/);
    assert.equal(sc.state().items["i-a"].state, "investigating");
    run(sc, cmd({ cmd: "stack-comments", stack: "a", comments: [{ patch: "p-a", text: "nit" }] }));
    assert.deepEqual(executed(sc).at(-1), { ok: false, detail: "the author of test_a.js is running: send it again when it's done" });
  });

  it("a global tell-factory creates a request to route, named from its text; one for an unknown request does nothing", () => {
    const { request: _r, ...global } = cmd({ cmd: "tell-factory", text: "Burn down dom/base/test, skip Android" });
    const effects = commandEffects(global as Command, { config, exists: () => false, plan: () => undefined });
    assert.deepEqual(effects, [{ type: "event", event: { type: "request-created", request: "r-20261015-burn-down-dom-base-test-skip", kind: "unrouted", text: "Burn down dom/base/test, skip Android", command: global.id } }]);
    assert.deepEqual(commandEffects(cmd({ cmd: "tell-factory", request: "r-nope", text: "x" }), { config, exists: () => false, plan: () => undefined }), []);
  });

  it("tell-factory starts the recover agent, whose plan comes to you; a reply resumes it", () => {
    const sc = withPatch();
    const c = cmd({ cmd: "tell-factory", text: "Lando was down, re-push" });
    run(sc, c);
    const plan = sc.plan(`recover:${c.id}`);
    assert.equal(plan.name, "recover");
    assert.equal(plan.cwd, "/state");
    assert.deepEqual(plan.agent?.vars, { text: "Lando was down, re-push", id: ID, stateDir: `/state/requests/${ID}` });
    const retry: PlannedCommand = { cmd: "retry-job", job: "j-1", reason: "Lando error" };
    const job = sc.complete(`recover:${c.id}`, { report: { plan: [retry], cannotDo: [], questions: ["which push?"], feedback: [] } });
    const s = sc.state();
    assert.deepEqual(s.recoveryPlans[0].plan, [retry]);
    assert.deepEqual(s.needsUser.map((x) => [x.key, x.job]), [[`recovery:${job}`, job]]);

    const reply = cmd({ cmd: "reply-recovery", job, text: "push A" });
    run(sc, reply);
    assert.equal(sc.plan(`recover:${reply.id}`).agent?.resume, true);
    const second = sc.complete(`recover:${reply.id}`, { report: { plan: [], cannotDo: [], questions: [], feedback: [] } });
    assert.deepEqual(sc.open(), [`recovery:${second}`]);
  });

  it("running a command of a recovery plan answers that plan; set-state answers the item's failed job", () => {
    const sc = withPatch();
    const c = cmd({ cmd: "tell-factory", text: "it's fixed on central" });
    run(sc, c);
    const planned: PlannedCommand = { cmd: "set-state", item: "i-a", state: "left as-is", reason: "fixed on central" };
    const job = sc.complete(`recover:${c.id}`, { report: { plan: [planned], cannotDo: [], questions: [], feedback: [] } });
    sc.add({ type: "needs-user", request: ID, key: "failed:j-9", action: "failed", detail: "d", job: "j-9", item: "i-a" });
    assert.deepEqual(sc.open(), [`recovery:${job}`, "failed:j-9"]);
    run(sc, cmd({ ...planned }));
    assert.deepEqual(sc.open(), []);
  });

  it("retry-job runs a script again as written and an agent by resuming it; cancel-job cancels", () => {
    const sc = withPatch();
    sc.startJob({ purpose: { key: "prior-art:i-a", what: "prior-art", item: "i-a" }, kind: "script", name: "bugzilla.ts prior-art", item: "i-a", cwd: "/r", cli: { tool: "bugzilla.ts", args: ["prior-art", "a/test_a.js"] } });
    const job = sc.complete("prior-art:i-a", { exitCode: 1, error: "down" });
    sc.add({ type: "needs-user", request: ID, key: `failed:${job}`, action: "failed", detail: "down", job });
    run(sc, cmd({ cmd: "retry-job", job, reason: "Bugzilla is back" }));
    assert.deepEqual(sc.plan("prior-art:i-a").cli, { tool: "bugzilla.ts", args: ["prior-art", "a/test_a.js"] });
    assert.deepEqual(sc.open(), []);

    const author = sc.view().byKey.get("author:i-a:initial")![0].job;
    run(sc, cmd({ cmd: "retry-job", job: author, reason: "r" }));
    assert.equal(sc.plan("author:i-a:initial").agent?.resume, true);
    // Its session is now running: a second retry waits.
    run(sc, cmd({ cmd: "retry-job", job: author, reason: "r" }));
    assert.equal(executed(sc).at(-1)?.ok, false);
    assert.deepEqual(run(sc, cmd({ cmd: "cancel-job", job: author, reason: "stuck" }))[0], { type: "cancel", job: author, request: ID, detail: "cancelled by you" });
  });

  it("resume-agent, set-state, redo-step, edit-config and shell", () => {
    const sc = withPatch();
    const resume = cmd({ cmd: "resume-agent", item: "i-a", message: "stop and report what you have", reason: "6 hours" });
    run(sc, resume);
    assert.equal(sc.plan(`author:i-a:recovery:${resume.id}`).agent?.message, "stop and report what you have");
    sc.complete(`author:i-a:recovery:${resume.id}`, { report: { state: "handed back", summary: "s", cause: "c", verification: "v", commits: [], landsAfter: [], feedback: [] } });
    run(sc, cmd({ cmd: "set-state", item: "i-a", state: "left as-is", reason: "fixed on central" }));
    assert.equal(sc.state().items["i-a"].state, "left as-is");
    run(sc, cmd({ cmd: "redo-step", item: "i-a", step: "investigate and fix", reason: "new info" }));
    assert.equal(sc.view().itemResets.get("i-a"), 1);
    run(sc, cmd({ cmd: "redo-step", step: "verify on try", reason: "re-plan" }));
    assert.equal(sc.state().step, "verify on try");
    run(sc, cmd({ cmd: "edit-config", config: { platforms: ["linux"] }, reason: "r" }));
    assert.deepEqual(sc.state().config, { platforms: ["linux"] });
    const shell = cmd({ cmd: "shell", cwd: "/wt/a", command: "git status", reason: "look" });
    run(sc, shell);
    const plan = sc.plan(`shell:${shell.id}`);
    assert.deepEqual([plan.cwd, plan.cmd], ["/wt/a", ["sh", "-c", "git status"]]);
  });

  it("start-agent starts a fresh session on the item, which later resumes use", () => {
    const sc = withPatch();
    const c = cmd({ cmd: "start-agent", item: "i-a", prompt: "Fix it in the product, not with a wait.", reason: "avoid the timeout approach" });
    run(sc, c);
    const plan = sc.plan(`author:i-a:start:${c.id}`);
    assert.equal(plan.agent?.resume, false);
    assert.notEqual(plan.agent?.sessionId, "s-1");
    assert.equal(plan.name, "investigate-and-fix");
    assert.match(String(plan.agent?.vars?.failureSummary), /Instructions for this run: Fix it in the product, not with a wait\./);
    sc.complete(`author:i-a:start:${c.id}`, { report: { state: "left as-is", summary: "s", cause: "c", verification: "v", commits: [], landsAfter: [], feedback: [] } });
    const fix = cmd({ cmd: "comment-fix", patch: "p-a", text: "x" });
    run(sc, fix);
    assert.equal(sc.plan(`author:i-a:comment:${fix.id}`).agent?.sessionId, plan.agent?.sessionId);
    run(sc, cmd({ cmd: "start-agent", item: "i-nope", prompt: "x", reason: "r" }));
    assert.equal(executed(sc).at(-1)?.ok, false, "an item without an earlier run can't be started again");
  });

  it("command-executed names its cmd, so the page can say what was refused", () => {
    const sc = withPatch();
    run(sc, cmd({ cmd: "start-agent", item: "i-nope", prompt: "x", reason: "r" }));
    const refused = sc.state().refused!;
    assert.equal(refused.length, 1);
    assert.equal(refused[0].cmd, "start-agent");
    assert.equal(refused[0].detail, "the investigation of this group can only be restarted after a first one");
    run(sc, cmd({ cmd: "dismiss", key: refused[0].key }));
    assert.deepEqual(sc.state().refused, []);
  });

  it("accept-review makes the item reviewed and answers its ⚑, only after the review rounds", () => {
    const sc = withPatch();
    const review = (job: string, exitCode: number) => {
      sc.add({ type: "job-started", request: ID, job, item: "i-a", kind: "agent", name: "review-patch", pid: 1, pidStartTime: 1, cmd: ["claude"], cwd: "/wt/a", codeVersion: "t" });
      sc.add({ type: "job-finished", request: ID, job, exitCode, durationMs: 1 });
    };
    review("j-crash", 1);
    sc.add({ type: "needs-user", request: ID, key: "failed:j-crash", action: "review-patch failed twice", detail: "d", job: "j-crash", item: "i-a" });
    run(sc, cmd({ cmd: "accept-review", item: "i-a" }));
    assert.match(executed(sc).at(-1)!.detail!, /isn't waiting for you/, "a crashed review is retried, not accepted");
    sc.add({ type: "user-done", request: ID, key: "failed:j-crash" });
    review("j-rev", 0);
    sc.add({ type: "item-state", request: ID, item: "i-a", state: "blocked", detail: "critical review" });
    sc.add({ type: "needs-user", request: ID, key: "failed:j-rev", action: "No ok after 3 critical review rounds", detail: "d", job: "j-rev", item: "i-a" });
    run(sc, cmd({ cmd: "accept-review", item: "i-a" }));
    assert.equal(sc.state().items["i-a"].state, "reviewed");
    assert.deepEqual(sc.open(), []);
  });

  it("dismiss never answers a ⚑ whose user-done means something (an approval, a bug filed...)", () => {
    const sc = withPatch();
    sc.add({ type: "needs-user", request: ID, key: "approve-push:A", action: "Approve", detail: "", push: "A" });
    run(sc, cmd({ cmd: "dismiss", key: "approve-push:A" }));
    assert.deepEqual(sc.open(), ["approve-push:A"]);
    assert.equal(executed(sc).at(-1)?.ok, false);
  });

  it("stop raises a ⚑ for a job without an item too, refuses try pushes; retry answers it", () => {
    const sc = withPatch();
    sc.startJob({ purpose: { key: "plan-pushes", what: "plan-pushes" }, kind: "agent", name: "plan-try-pushes", cwd: "/r", agent: { sessionId: "s-p", resume: false, message: "x" } });
    const job = sc.running("plan-pushes");
    run(sc, cmd({ cmd: "stop", job }));
    assert.deepEqual(sc.open(), [`stopped:${job}`]);
    sc.complete("plan-pushes", { exitCode: -1, error: "cancelled by you" });
    run(sc, cmd({ cmd: "retry", job }));
    assert.ok(sc.running("plan-pushes"));
    assert.deepEqual(sc.open(), []);
    sc.startJob({ purpose: { key: "push:A", what: "push", push: "A" }, kind: "script", name: "try.ts push", cwd: "/r", cli: { tool: "try.ts", args: ["push"] } });
    const effects = run(sc, cmd({ cmd: "stop", job: sc.running("push:A") }));
    assert.ok(!effects.some((e) => e.type === "cancel"));
  });

  it("continue reopens the keys of the item's stopped jobs", () => {
    const sc = withPatch();
    sc.startJob({ purpose: { key: "lint:p-a:x", what: "lint", item: "i-a" }, kind: "script", name: "lint-text.ts commit", item: "i-a", cwd: "/r", cli: { tool: "lint-text.ts", args: [] } });
    const lint = sc.running("lint:p-a:x");
    run(sc, cmd({ cmd: "stop", job: lint }));
    sc.complete("lint:p-a:x", { exitCode: -1, error: "cancelled by you" });
    run(sc, cmd({ cmd: "continue", item: "i-a", text: "same commit, check it again" }));
    assert.ok(sc.view().done.has(`reopen:${lint}`));
  });

  it("retry after a stop takes the item out of the stopped state", () => {
    const sc = withPatch();
    const fix = cmd({ cmd: "comment-fix", patch: "p-a", text: "x" });
    run(sc, fix);
    const job = sc.running(`author:i-a:comment:${fix.id}`);
    run(sc, cmd({ cmd: "stop", job }));
    sc.complete(`author:i-a:comment:${fix.id}`, { exitCode: -1, error: "cancelled by you" });
    run(sc, cmd({ cmd: "retry", job }));
    assert.equal(sc.state().items["i-a"].state, "investigating");
    assert.deepEqual(sc.open(), []);
  });

  it("allow-push lets the item's author session make one push", () => {
    const sc = withPatch();
    const fix = cmd({ cmd: "comment-fix", patch: "p-a", text: "x" });
    run(sc, fix);
    const session = sc.view().jobs.find((j) => j.item === "i-a" && j.purpose.what === "author")!.sessionId;
    const effects = run(sc, cmd({ cmd: "allow-push", item: "i-a" }));
    assert.deepEqual(effects.filter((e) => e.type === "allow-push"), [{ type: "allow-push", sessionId: session }]);
    assert.equal(executed(sc).at(-1)?.ok, true);
  });

  it("continue resumes the item's author with your message and answers its ⚑s; refused while it runs", () => {
    const sc = withPatch();
    sc.add({ type: "item-state", request: ID, item: "i-a", state: "left as-is" });
    sc.add({ type: "needs-user", request: ID, key: "failed:j-rev", action: "No ok", detail: "d", job: "j-rev", item: "i-a" });
    const c = cmd({ cmd: "continue", item: "i-a", text: "The wait is fine here, keep it and answer the reviewer." });
    run(sc, c);
    const plan = sc.plan(`author:i-a:continue:${c.id}`);
    assert.equal(plan.agent?.sessionId, "s-1");
    assert.equal(plan.agent?.resume, true);
    assert.match(String(plan.agent?.message), /keep it and answer the reviewer/);
    assert.equal(sc.state().items["i-a"].state, "investigating", "a closed item reopens");
    assert.deepEqual(sc.open(), []);
    run(sc, cmd({ cmd: "continue", item: "i-a", text: "more" }));
    assert.match(executed(sc).at(-1)!.detail!, /is running/);
  });

  it("retry is retry-job without a reason, never for a try push", () => {
    const sc = withPatch();
    sc.startJob({ purpose: { key: "prior-art:i-a", what: "prior-art", item: "i-a" }, kind: "script", name: "bugzilla.ts prior-art", item: "i-a", cwd: "/r", cli: { tool: "bugzilla.ts", args: ["prior-art"] } });
    const job = sc.complete("prior-art:i-a", { exitCode: 1, error: "down" });
    sc.add({ type: "needs-user", request: ID, key: `failed:${job}`, action: "failed", detail: "down", job, item: "i-a" });
    run(sc, cmd({ cmd: "retry", job }));
    assert.ok(sc.running("prior-art:i-a"));
    assert.deepEqual(sc.open(), []);
    sc.startJob({ purpose: { key: "push:A", what: "push", push: "A" }, kind: "script", name: "try.ts push", cwd: "/r", cli: { tool: "try.ts", args: ["push"] } });
    const push = sc.complete("push:A", { exitCode: 1, error: "lando" });
    const effects = run(sc, cmd({ cmd: "retry", job: push }));
    assert.ok(!effects.some((e) => e.type === "start"));
    assert.match(executed(sc).at(-1)!.detail!, /try push isn't retried/);
  });

  it("stop cancels a running job, blocks its item and raises a ⚑ that continue answers", () => {
    const sc = withPatch();
    const resume = cmd({ cmd: "comment-fix", patch: "p-a", text: "x" });
    run(sc, resume);
    const job = sc.running(`author:i-a:comment:${resume.id}`);
    const effects = run(sc, cmd({ cmd: "stop", job }));
    assert.deepEqual(effects[0], { type: "cancel", job, request: ID, detail: "cancelled by you" });
    assert.equal(sc.state().items["i-a"].state, "blocked");
    assert.equal(sc.state().items["i-a"].detail, "stopped by you");
    assert.deepEqual(sc.open(), [`stopped:${job}`]);
    sc.complete(`author:i-a:comment:${resume.id}`, { exitCode: -1, error: "cancelled by you" });
    run(sc, cmd({ cmd: "continue", item: "i-a", text: "go on" }));
    assert.deepEqual(sc.open(), []);
    run(sc, cmd({ cmd: "stop", job }));
    assert.match(executed(sc).at(-1)!.detail!, /isn't running/);
  });
});
