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
  it("new-request names the request from its folder, text or revision", () => {
    const c = (f: Record<string, string>) => cmd({ cmd: "new-request", kind: "burndown", text: "", ...f }) as Extract<Command, { cmd: "new-request" }>;
    assert.equal(newRequestId(c({ folder: "browser/components/sessionstore/test" }), () => false), "r-20261015-sessionstore-test");
    assert.equal(newRequestId(c({ text: "Fix the xpcshell cwd failures", kind: "try-push", rev: "abc" }), () => false), "r-20261015-fix-the-xpcshell-cwd");
    assert.equal(newRequestId(c({ folder: "a/b" }), (id) => id === "r-20261015-a-b"), "r-20261015-a-b-2");
    const [e] = commandEffects(c({ folder: "a/b" }), { config, exists: () => false, plan: () => undefined });
    assert.deepEqual(e, { type: "event", event: { type: "request-created", request: "r-20261015-a-b", kind: "burndown", text: "", folder: "a/b" } });
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
    sc.add({ type: "needs-user", request: ID, key: "file-bug:p-a", action: "File", detail: "", patch: "p-a" });
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
    assert.deepEqual(executed(sc).at(-1), { ok: false, detail: "the author of i-a is running: send it again when it's done" });
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
    const c = cmd({ cmd: "start-agent", item: "i-a", prompt: "investigate-and-fix", reason: "avoid the timeout approach" });
    run(sc, c);
    const plan = sc.plan(`author:i-a:start:${c.id}`);
    assert.equal(plan.agent?.resume, false);
    assert.notEqual(plan.agent?.sessionId, "s-1");
    assert.match(String(plan.agent?.vars?.failureSummary), /Note from the factory: avoid the timeout approach/);
    sc.complete(`author:i-a:start:${c.id}`, { report: { state: "left as-is", summary: "s", cause: "c", verification: "v", commits: [], landsAfter: [], feedback: [] } });
    const fix = cmd({ cmd: "comment-fix", patch: "p-a", text: "x" });
    run(sc, fix);
    assert.equal(sc.plan(`author:i-a:comment:${fix.id}`).agent?.sessionId, plan.agent?.sessionId);
    run(sc, cmd({ cmd: "start-agent", item: "i-a", prompt: "review-patch", reason: "r" }));
    assert.equal(executed(sc).at(-1)?.ok, false);
  });
});
