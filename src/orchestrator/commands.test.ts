import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Command, Event, PlannedCommand } from "../types.ts";
import { foldEvents } from "../state/fold.ts";
import { buildView } from "./view.ts";
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

  it("copied-submit records when you copied a stack's moz-phab command", () => {
    const sc = withPatch();
    sc.add({ type: "stack", request: ID, stack: "a", folder: "a", branch: "b", worktree: "/wt", order: ["p-a"] });
    run(sc, cmd({ cmd: "copied-submit", stack: "a" }));
    assert.equal(sc.state().stacks.a.submitCopied, sc.of("submit-copied")[0].t);
  });

  it("copied-reorg answers a land ⚑, and only a land ⚑", () => {
    const sc = withPatch();
    sc.add({ type: "needs-user", request: ID, key: "land:a:h", action: "Stack reordered", detail: "", stack: "a" });
    run(sc, cmd({ cmd: "copied-reorg", key: "land:a:h" }));
    assert.deepEqual(sc.open(), []);
    sc.add({ type: "needs-user", request: ID, key: "resubmit:a", action: "Resubmit", detail: "", stack: "a" });
    run(sc, cmd({ cmd: "copied-reorg", key: "resubmit:a" }));
    assert.deepEqual(sc.open(), ["resubmit:a"]);
    assert.deepEqual(executed(sc), [{ ok: true, detail: undefined }, { ok: false, detail: "resubmit:a isn't a reorg to run" }]);
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

  it("revise-push asks for another in place of a push waiting for you, or one you declined, once", () => {
    const sc = withPatch();
    sc.add({ type: "needs-user", request: ID, key: "approve-push:A", action: "Approve", detail: "", push: "A" });
    sc.add({ type: "try-planned", request: ID, push: "A", purpose: "p", command: ["./mach", "try"] });
    run(sc, cmd({ cmd: "revise-push", push: "A", text: "on mac" }));
    assert.deepEqual([sc.state().pushes.A.declined, sc.state().pushes.A.replan], ["on mac", true]);
    assert.deepEqual(sc.open(), []);
    run(sc, cmd({ cmd: "revise-push", push: "A", text: "again" }));

    // Declined first, then asked for another.
    sc.add({ type: "try-planned", request: ID, push: "B", purpose: "p", command: ["./mach", "try"] });
    sc.add({ type: "try-declined", request: ID, push: "B", text: "too slow" });
    run(sc, cmd({ cmd: "revise-push", push: "B", text: "fewer jobs" }));
    assert.equal(sc.state().pushes.B.replan, true);

    // Not one the factory withdrew, one made, or one never waiting for you.
    sc.add({ type: "try-planned", request: ID, push: "C", purpose: "p", command: ["./mach", "try"] });
    sc.add({ type: "try-declined", request: ID, push: "C", text: "not needed anymore", by: "factory" });
    run(sc, cmd({ cmd: "revise-push", push: "C", text: "x" }));
    sc.add({ type: "try-planned", request: ID, push: "D", purpose: "p", command: ["./mach", "try"] });
    sc.add({ type: "try-pushed", request: ID, push: "D", rev: "fed", url: "u" });
    run(sc, cmd({ cmd: "revise-push", push: "D", text: "x" }));
    sc.add({ type: "try-planned", request: ID, push: "E", purpose: "p", command: ["./mach", "try"] });
    run(sc, cmd({ cmd: "revise-push", push: "E", text: "x" }));
    run(sc, cmd({ cmd: "revise-push", push: "nope", text: "x" }));
    assert.deepEqual(executed(sc).map((e) => e.ok), [true, false, true, false, false, false, false]);
    assert.equal(sc.state().pushes.C.replan, undefined);
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

  it("hand-back on a take-it leaves every group of that test to them, and only those", () => {
    const sc = withPatch();
    const item = (id: string, test: string) => sc.add({ type: "item-created", request: ID, item: id, folder: "a", group: { message: id, tests: [test], configs: ["linux"] } });
    item("i-a-2", "a/test_a.js");
    item("i-b", "a/test_b.js");
    sc.add({ type: "needs-user", request: ID, key: "take-it:i-a", action: "Someone else may be fixing test_a.js", detail: "", item: "i-a" });
    run(sc, cmd({ cmd: "hand-back", item: "i-a" }));
    const s = sc.state();
    assert.deepEqual(["i-a", "i-a-2", "i-b"].map((i) => s.items[i].state), ["handed back", "handed back", "not started"]);
    assert.deepEqual(sc.open(), []);
  });

  it("redo-annotations starts the skip-ifs group over", () => {
    const sc = withPatch();
    sc.add({ type: "item-created", request: ID, item: "i-annotations", folder: "a", group: { message: "skip-if annotations", tests: ["a/test_a.js"], configs: ["linux"] } });
    sc.add({ type: "item-state", request: ID, item: "i-annotations", state: "left as-is" });
    run(sc, cmd({ cmd: "redo-annotations" }));
    assert.equal(sc.state().items["i-annotations"].state, "not started");
    assert.equal(sc.view().itemResets.get("i-annotations"), 1);
    assert.ok(executed(sc).every((e) => e.ok));
  });

  it("poll-phab asks for a Phabricator poll now", () => {
    const sc = withPatch();
    run(sc, cmd({ cmd: "poll-phab" }));
    assert.equal(sc.state().pollRequested, sc.of("poll-requested")[0].t);
    assert.deepEqual(executed(sc), [{ ok: true, detail: undefined }]);
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
    assert.equal(sc.plan(key).purpose.reason, "it's in DOM: Events", "the page says what it revised it after");
    assert.equal(sc.plan(key).item, "i-a", "listed with its group's jobs");
    sc.complete(key, { report: { draft: { product: "Core", component: "DOM: Events", summary: "s", description: "d" }, feedback: [] } });
    assert.equal(sc.state().patches["p-a"].bugDraft?.component, "DOM: Events");
  });

  it("a comment on the meta bug draft goes to the session that wrote it, which looks up what it needs", () => {
    const sc = withPatch();
    sc.startJob({ purpose: { key: "meta-draft:root:h", what: "meta-draft", stack: "root" }, kind: "agent", name: "write-meta-bug", cwd: "/wt/root", agent: { sessionId: "s-meta", resume: false, vars: { subject: "s", worktree: "/wt/root", stackFile: "f", overall: "o", summary: "" } } });
    sc.complete("meta-draft:root:h", { report: { description: "d", summary: "[meta] x", feedback: [] } });
    sc.add({ type: "meta-bug", request: ID, bug: null, draft: { product: "Core", component: "DOM", summary: "[meta] x", description: "d", blocks: [2063593] } });
    const c = cmd({ cmd: "comment-bug-draft", patch: "meta", text: "reference the bugs that added the standalone jobs" });
    run(sc, c);
    const plan = sc.plan(`meta-draft:root:revise:${c.id}`);
    assert.deepEqual([plan.name, plan.agent?.sessionId, plan.agent?.resume, plan.cwd], ["write-meta-bug", "s-meta", true, "/wt/root"]);
    assert.match(plan.agent?.message ?? "", /reference the bugs that added the standalone jobs[\s\S]*Never ask them for something you can find/);
    // Bug fields it was asked to change go into the draft.
    sc.complete(`meta-draft:root:revise:${c.id}`, { report: { description: "d2", answer: "moved it", product: "Testing", component: "General", blocks: [1975728], feedback: [] } });
    const draft = sc.state().metaBug?.draft;
    assert.deepEqual([draft?.product, draft?.component, draft?.blocks, draft?.description, draft?.summary], ["Testing", "General", [2063593, 1975728], "d2", "[meta] x"]);
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
    // It answers each point with what backs it; the page shows the comment with that answer.
    assert.match(plan.agent?.message ?? "", /answering each point of it in a line/);
    assert.deepEqual(sc.state().patches["p-a"].yourComments?.map((x) => [x.text, x.key]), [["drop the timeout", `author:i-a:comment:${c.id}`]]);
    run(sc, cmd({ cmd: "stack-comments", stack: "a", comments: [{ patch: "p-a", text: "nit" }] }));
    assert.deepEqual(executed(sc).at(-1), { ok: false, detail: "the author of test_a.js is running: send it again when it's done" });
    assert.equal(sc.state().patches["p-a"].yourComments?.length, 1, "not sent, not shown");
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
    const job = sc.complete(`recover:${c.id}`, { report: { answer: "I'll retry the push.", plan: [retry], cannotDo: [], questions: ["which push?"], feedback: [] } });
    const s = sc.state();
    assert.deepEqual(s.recoveryPlans[0].plan, [retry]);
    assert.equal(s.recoveryPlans[0].answer, "I'll retry the push.");
    assert.equal(s.needsUser[0].action, "Its answer to you");
    assert.deepEqual(s.needsUser.map((x) => [x.key, x.job]), [[`recovery:${job}`, job]]);

    const reply = cmd({ cmd: "reply-recovery", job, text: "push A" });
    run(sc, reply);
    assert.equal(sc.plan(`recover:${reply.id}`).agent?.resume, true);
    const second = sc.complete(`recover:${reply.id}`, { report: { answer: "Done.", plan: [], cannotDo: [], questions: [], feedback: [] } });
    assert.deepEqual(sc.open(), [`recovery:${second}`]);
  });

  it("running a command of a recovery plan answers that plan; set-state answers the item's failed job", () => {
    const sc = withPatch();
    const c = cmd({ cmd: "tell-factory", text: "it's fixed on central" });
    run(sc, c);
    const planned: PlannedCommand = { cmd: "set-state", item: "i-a", state: "left as-is", reason: "fixed on central" };
    const job = sc.complete(`recover:${c.id}`, { report: { answer: "Done.", plan: [planned], cannotDo: [], questions: [], feedback: [] } });
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

  it("hand-off stops the factory's work on the groups, keeps them out of its hands, and writes the prompt for your session from all it knows", () => {
    const sc = withPatch();
    const resume = cmd({ cmd: "resume-agent", item: "i-a", message: "look again", reason: "r" });
    run(sc, resume);
    const running = sc.view().byKey.get(`author:i-a:recovery:${resume.id}`)![0].job;
    sc.add({ type: "needs-user", request: ID, key: "file-bug:p-a", action: "file", detail: "d", patch: "p-a", item: "i-a" });
    const c = cmd({ cmd: "hand-off", items: ["i-a"], reason: "GC/CC is mine now" });
    const effects = run(sc, c);
    assert.deepEqual(effects.find((e) => e.type === "cancel"), { type: "cancel", job: running, request: ID, detail: "cancelled by you" });
    assert.equal(sc.state().items["i-a"].state, "taken over");
    assert.deepEqual(sc.open(), []);
    const plan = sc.plan(`hand-off:${c.id}`);
    assert.equal(plan.name, "write-hand-off");
    const refs = JSON.parse(plan.files![0].content);
    assert.equal(plan.agent?.vars?.referencesFile, plan.files![0].path);
    assert.deepEqual(refs.groups[0].patches.map((p: { sha: string }) => p.sha), [sha("1")]);
    assert.deepEqual(refs.groups[0].sessions.map((x: { sessionId: string }) => x.sessionId), ["s-1", "s-1"]);
    assert.match(refs.groups[0].sessions[0].transcript, /\/\.claude\/projects\/-wt-a\/s-1\.jsonl$/);
    assert.equal(refs.groups[0].worktrees[0].keptCommits, "refs/fix-factory/a/");
    sc.complete(`hand-off:${c.id}`, { report: { prompt: "Take over test_a.js.\n", feedback: [] } });
    assert.deepEqual(sc.state().handOffs.map((h) => [h.items, h.text]), [[["i-a"], "Take over test_a.js."]]);
  });

  it("split-request makes a request per part with its groups' history and the pushes made, and archives this one", () => {
    const sc = withPatch();
    sc.add({ type: "item-created", request: ID, item: "i-b", folder: "b", group: { message: "bang", tests: ["b/test_b.js"], configs: ["linux"] } });
    sc.startJob({ purpose: { key: "author:i-b:initial", what: "author", item: "i-b", reason: "initial" }, kind: "agent", name: "investigate-and-fix", item: "i-b", cwd: "/wt/b", agent: { sessionId: "s-2", resume: false, vars: { test: "b/test_b.js", worktree: "/wt/b", failureSummary: "bang" } } });
    sc.complete("author:i-b:initial", { report: { state: "fix verified locally", summary: "s", cause: "c", verification: "v", commits: [sha("2")], landsAfter: [], feedback: [] } });
    sc.add({ type: "patch", request: ID, patch: "p-b", item: "i-b", sha: sha("2"), worktree: "/wt/b", title: "Bug 5 - Fix b", bug: 5 });
    for (const item of ["i-a", "i-b"]) sc.add({ type: "item-state", request: ID, item, state: "in stack" });
    sc.add({ type: "try-planned", request: ID, push: "root-1", purpose: "the stack", command: ["./mach", "try"] });
    sc.add({ type: "try-pushed", request: ID, push: "root-1", rev: "r1", url: "https://treeherder/r1" });
    sc.add({ type: "try-finished", request: ID, push: "root-1", result: "green", summary: "green" });
    sc.add({ type: "try-planned", request: ID, push: "root-2", purpose: "not made", command: ["./mach", "try"] });
    sc.add({ type: "needs-user", request: ID, key: "file-bug:p-a", action: "file", detail: "d", patch: "p-a", item: "i-a" });
    sc.add({ type: "needs-user", request: ID, key: "approve-push:root-2", action: "approve", detail: "d", push: "root-2" });
    const split = (parts: { title: string; groups: { item: string; why: string }[] }[]) =>
      commandEffects(cmd({ cmd: "split-request", parts, reason: "two topics" }), { config, state: sc.state(), view: sc.view(), exists: () => false, plan: () => undefined, events: () => sc.events });
    const parts = [{ title: "Fix the tests failing alone", groups: [{ item: "i-a", why: "removes a standalone skip-if" }] }, { title: "Fix intermittent failures", groups: [{ item: "i-b", why: "no skip-if" }] }];

    sc.add({ type: "dep", request: ID, dep: { patch: "p-b", needs: "p-a", kind: "hard", reason: "builds on it", source: "textual" } });
    const refused = split(parts);
    assert.match(refused.map((e) => (e.type === "event" && e.event.type === "command-executed" ? e.event.detail : "")).join(""), /Fix b needs Bug XXXXXXX - Fix \(builds on it\): put them in the same part/);
    sc.add({ type: "dep-removed", request: ID, patch: "p-b", needs: "p-a" });

    const byRequest = new Map<string, Event[]>();
    for (const e of split(parts)) if (e.type === "event") byRequest.set(e.event.request, [...(byRequest.get(e.event.request) ?? []), { v: 1, t: "2026-10-27T10:00:00.000Z", ...e.event } as Event]);
    const ids = [...byRequest.keys()].filter((id) => id !== ID);
    assert.deepEqual(ids, ["r-20261015-fix-the-tests-failing", "r-20261015-fix-intermittent-failures"]);
    const [a, b] = ids.map((id) => foldEvents(byRequest.get(id)!));
    assert.deepEqual([Object.keys(a.items), Object.keys(a.patches), Object.keys(b.items), Object.keys(b.patches)], [["i-a"], ["p-a"], ["i-b"], ["p-b"]]);
    assert.equal(a.splitFrom, ID);
    assert.equal(a.step, "stack");
    assert.equal(a.text, "Fix the tests failing alone");
    // The push made is evidence for both; the planned one isn't copied, nor the stack's flags.
    assert.deepEqual([Object.keys(a.pushes), Object.keys(b.pushes)], [["root-1"], ["root-1"]]);
    assert.equal(a.pushes["root-1"].result, "green");
    assert.deepEqual(a.needsUser.map((n) => n.key), ["file-bug:p-a"]);
    assert.deepEqual(b.needsUser, []);
    // Their sessions, which resumes use.
    assert.deepEqual(Object.values(b.jobs).map((j) => j.sessionId), ["s-2"]);
    // Its planner takes it from there: its own stack, from its groups' commits.
    const part = new Scenario("try-push", { rev: "abc" });
    const [created, ...rest] = byRequest.get(ids[1])!;
    part.events = [created, ...part.events.slice(1, 3).map((e) => ({ ...e, request: ids[1] })), ...rest];
    for (const [job, report] of sc.reports) part.reports.set(job, report);
    assert.ok(part.settle().includes("wt:root"), "a worktree for its stack");
    const original = foldEvents([...sc.events, ...byRequest.get(ID)!]);
    assert.deepEqual([original.splitInto, original.step, original.needsUser], [ids, "done", []]);
    assert.deepEqual(original.movedTo, { "i-a": ids[0], "i-b": ids[1] });
    // A group in the wrong part moves to another of the same split, with its history; its pushes are there already.
    const source = byRequest.get(ids[0])!;
    const move = commandEffects(cmd({ cmd: "move-groups", request: ids[0], to: ids[1], groups: [{ item: "i-a", why: "no skip-if" }], reason: "wrong part" }), {
      config, state: foldEvents(source), view: buildView(source), exists: () => true, plan: () => undefined,
      events: (id) => byRequest.get(id)!, other: (id) => foldEvents(byRequest.get(id)!),
    });
    for (const e of move) if (e.type === "event") byRequest.get(e.event.request)!.push({ v: 1, t: "2026-10-27T11:00:00.000Z", ...e.event } as Event);
    const [from, to] = [foldEvents(byRequest.get(ids[0])!), foldEvents(byRequest.get(ids[1])!)];
    assert.deepEqual([from.items["i-a"].state, from.movedTo], ["taken over", { "i-a": ids[1] }]);
    assert.deepEqual([Object.keys(to.items).sort(), Object.keys(to.patches).sort(), Object.keys(to.pushes)], [["i-a", "i-b"], ["p-a", "p-b"], ["root-1"]]);
    assert.ok(move.some((e) => e.type === "copy-report" && e.to === ids[1]), "its author's report goes along");
    // What's sent to it afterwards is refused: its groups go on elsewhere.
    for (const e of byRequest.get(ID)!) sc.add(e);
    run(sc, cmd({ cmd: "continue", item: "i-a", text: "remove the skip-if" }));
    assert.match(executed(sc).at(-1)?.detail ?? "", /this request was split into r-20261015-fix-the-tests-failing, r-20261015-fix-intermittent-failures: send it there/);
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

  it("dismiss answers a resubmit you decide against", () => {
    const sc = withPatch();
    sc.add({ type: "needs-user", request: ID, key: "resubmit:a", action: "Resubmit", detail: "", stack: "a" });
    run(sc, cmd({ cmd: "dismiss", key: "resubmit:a" }));
    assert.deepEqual(sc.open(), []);
    assert.equal(executed(sc).at(-1)?.ok, true);
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

  it("retry resumes an agent where it stopped, and says so rather than starting it again", () => {
    const sc = withPatch();
    const fix = cmd({ cmd: "comment-fix", patch: "p-a", text: "x" });
    run(sc, fix);
    const job = sc.running(`author:i-a:comment:${fix.id}`);
    sc.complete(`author:i-a:comment:${fix.id}`, { exitCode: 1, error: "killed" });
    const effects = run(sc, cmd({ cmd: "retry", job }));
    const start = effects.find((e) => e.type === "start");
    assert.ok(start?.type === "start" && start.plan.agent?.resume && start.plan.purpose.retried);
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

  it("hand-back closes a stuck group and answers all its ⚑s", () => {
    const sc = withPatch();
    sc.add({ type: "needs-user", request: ID, key: "failed:j-rev", action: "No ok", detail: "d", job: "j-rev", item: "i-a" });
    run(sc, cmd({ cmd: "hand-back", item: "i-a" }));
    assert.equal(sc.state().items["i-a"].state, "handed back");
    assert.deepEqual(sc.open(), []);
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

  it("retries a refused try push once: not while it runs again, nor once it's made", () => {
    const sc = withPatch();
    sc.startJob({ purpose: { key: "push:A", what: "push", push: "A" }, kind: "script", name: "try.ts push", cwd: "/r", cli: { tool: "try.ts", args: ["push"] } });
    const refused = sc.complete("push:A", { exitCode: 1, error: "not pushed: commits changed since the approved dry run" });
    run(sc, cmd({ cmd: "retry", job: refused }));
    sc.running("push:A");
    const effects = run(sc, cmd({ cmd: "retry", job: refused }));
    assert.ok(!effects.some((e) => e.type === "start"));
    assert.match(executed(sc).at(-1)!.detail!, /try push isn't retried/);
    // The retry pushed, though it failed after: the push is made.
    sc.complete("push:A", { exitCode: 1, error: "lando timeout" });
    sc.add({ type: "try-pushed", request: ID, push: "A", rev: "r1", url: "u1" });
    assert.ok(!run(sc, cmd({ cmd: "retry", job: refused })).some((e) => e.type === "start"));
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
