// One test per step transition of docs/MVP.md, plus the rules of docs/ORCHESTRATOR.md.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InvalidReport } from "./handlers.ts";
import { commandEffects } from "./commands.ts";
import { landingState } from "../state/landing.ts";
import type { Command } from "../types.ts";
import { resumeAuthorPlan, similarMessages, stackId } from "./next.ts";
import { config, HOUR, ID, Scenario, sha } from "./testkit.ts";
import { shortHash } from "./plan.ts";
import { needsMetaBug } from "../state/meta-bug.ts";

const none = { verdict: "none", quote: "no bug", feedback: [] };
const ok = { verdict: "ok", findings: [], feedback: [] };
const bugDraft = { product: "Core", component: "XPCOM", summary: "s", description: "d" };
const lintOk = { ok: true, violations: [] };
const fixed = (commits: string[], extra = {}) => ({ state: "fix verified locally", summary: "fixed", cause: "c", verification: "v", commits, landsAfter: [], feedback: [], ...extra });
const imported = (s: string, title: string, files: string[], bug: number | null = null) => [{ sha: s, title, bug, reviewers: [], files, insertions: 1, deletions: 0, testOnly: true }];
const table = (rows: unknown[] = [], unparsed: unknown[] = []) => ({ rev: "abc", pushId: 1, project: "try", complete: true, pending: 0, configs: [], rows, unparsed });
const failure = (test: string, message: string) => ({ test, config: "linux/opt-xpcshell", message, taskIds: ["T1"], count: 1 });
const group = (key: string, test: string, message: string, rate = 1) => ({ key, message, tests: [test], configs: ["linux/opt-xpcshell"], ratePerWeek: rate, taskIds: ["T1"] });
// The key of the latest job whose key starts with prefix (order and reorder keys end with a hash of the order's input).
const keyOf = (sc: Scenario, prefix: string) => sc.view().jobs.findLast((j) => j.purpose.key.startsWith(prefix))!.purpose.key;

// A try-push request whose initial push has finished.
function tryPushFinished(): Scenario {
  const sc = new Scenario("try-push", { rev: "abc" });
  sc.step();
  sc.settle();
  sc.complete("watch:initial", { output: "" });
  sc.add({ type: "try-finished", request: ID, push: "initial", result: "failures", summary: "2 failures" });
  return sc;
}

// The work list of tryPushFinished, with these groups.
function workList(groups: ReturnType<typeof group>[]): Scenario {
  const sc = tryPushFinished();
  sc.step();
  sc.complete("try-table:initial:final", { output: table() });
  sc.complete("collect:initial:final", { output: groups.map((g) => failure(g.tests[0], g.message)) });
  sc.step();
  sc.complete("cluster:initial:final", { output: { groups, singles: [] } });
  if (groups.length > 1) {
    sc.step();
    sc.complete("merge:initial:final", { report: { groups: groups.map((g) => ({ message: g.message, tests: g.tests, configs: g.configs, from: [g.key], reason: "unchanged" })), feedback: [] } });
  }
  sc.settle();
  return sc;
}

// An item through prior art to its investigate-and-fix run.
function investigating(sc: Scenario, item: string): void {
  sc.settle();
  sc.complete(`prior-art:${item}`, { output: { bugs: [] } });
  sc.settle();
  sc.complete(`prior-art-verdict:${item}`, { report: none });
  sc.settle();
  sc.complete(`wt:${item}`, { output: { name: `${ID}-${item}`, path: `/wt/${ID}-${item}`, branch: `${ID}-${item}` } });
  sc.settle();
}

// The author reports a fix; import, lint and review all pass.
function reviewed(sc: Scenario, item: string, commit: string, test: string, opts: { title?: string; bug?: number | null; report?: object } = {}): void {
  // A fix has a bug of its own: the one its title gives, or else one to file.
  sc.complete(`author:${item}:initial`, { report: fixed([commit], opts.bug ? opts.report : { bugDraft, ...opts.report }) });
  sc.settle();
  const author = sc.view().byKey.get(`author:${item}:initial`)![0].job;
  sc.complete(`import:${author}`, { output: imported(commit, opts.title ?? `Bug XXXXXXX - Fix ${test}, r=smaug.`, [test], opts.bug ?? null) });
  sc.settle();
  const patch = `p-${item.slice(2)}`;
  sc.complete(`msg:${patch}:${commit}`, { output: "Bug XXXXXXX - Fix\n\nBody.\n" });
  sc.settle();
  sc.complete(`lint:${patch}:${commit}`, { output: lintOk });
  if (sc.view().byKey.has(`lint-bug:${author}`)) sc.complete(`lint-bug:${author}`, { output: lintOk });
  sc.settle();
  sc.complete(`review:${patch}:${author}`, { report: ok });
  sc.settle();
}

describe("similarMessages", () => {
  it("is true when 3/4 of the smaller message's words are shared, ignoring the harness's wording", () => {
    const bf = "Waiting for * entry is in BFCache";
    assert.ok(similarMessages(bf, "Waiting for example.org entry is in BFCache"));
    assert.ok(similarMessages(`Uncaught exception in test - ${bf} - timed out after 50 tries.`, "Waiting for example.org entry is in BFCache"));
    assert.ok(!similarMessages(bf, "Waiting for workers to respond"));
    assert.ok(!similarMessages(bf, "sw-error: registration failed"));
  });

  it("is false when either message has no word", () => {
    assert.ok(!similarMessages("", ""));
    assert.ok(!similarMessages("* 12", "* 12"));
    assert.ok(!similarMessages("", "Waiting for workers"));
  });
});

describe("1. request", () => {
  const routed = (fields: object) => ({ config: { folders: [], tests: [], platforms: [], constraints: [] }, questions: [], feedback: [], ...fields });

  it("routes text from the main box: a try push gets its kind and revision, then goes to the work list with its push", () => {
    const sc = new Scenario("unrouted", { text: "fix the failures of try push abcdef123456" });
    sc.activeRequests = [{ id: "r-20261014-other", summary: "Flakiness burndown of dom/base/test (step: work list)" }];
    assert.deepEqual(sc.step(), ["route"]);
    const plan = sc.plan("route");
    assert.equal(plan.name, "route-request");
    const requestsFile = `/state/requests/${ID}/data/requests.txt`;
    assert.deepEqual(plan.agent?.vars, { text: "fix the failures of try push abcdef123456", requestsFile });
    assert.deepEqual(plan.files, [{ path: requestsFile, content: "r-20261014-other  Flakiness burndown of dom/base/test (step: work list)\n" }]);
    assert.deepEqual(plan.purpose.requests, ["r-20261014-other"]);
    assert.deepEqual(sc.step(), []);
    sc.complete("route", { report: routed({ kind: "try-push", rev: "abcdef123456", questions: ["which platforms?"] }) });
    assert.equal(sc.state().kind, "try-push");
    assert.deepEqual(sc.state().config.questions, ["which platforms?"]);
    assert.deepEqual(sc.settle(), ["watch:initial"]);
    const s = sc.state();
    assert.equal(s.step, "work list");
    assert.equal(s.pushes.initial.rev, "abcdef123456");
    assert.equal(sc.plan("watch:initial").kind, "try-watch");
    assert.deepEqual(sc.plan("watch:initial").cli, { tool: "try.ts", args: ["watch", "abcdef123456"] });
  });

  it("routes a burndown to the first signal", () => {
    const sc = new Scenario("unrouted", { text: "burn down dom/base/test" });
    sc.step();
    assert.equal(sc.plan("route").files![0].content, "(no active requests)\n");
    sc.complete("route", { report: routed({ kind: "burndown", folder: "dom/base/test" }) });
    sc.step();
    const s = sc.state();
    assert.deepEqual([s.kind, s.folder, s.step], ["burndown", "dom/base/test", "first signal"]);
  });

  it("forwards text about an existing request to recover on it, and closes the new one", () => {
    const sc = new Scenario("unrouted", { text: "Lando was down, re-push" });
    sc.activeRequests = [{ id: "r-20261014-other", summary: "s" }];
    sc.step();
    const job = sc.complete("route", { report: { existing: "r-20261014-other", feedback: [] } });
    assert.deepEqual(sc.commands, [{ id: `forward-${job}`, cmd: "tell-factory", request: "r-20261014-other", text: "Lando was down, re-push" }]);
    const s = sc.state();
    assert.equal(s.step, "done");
    assert.equal(s.forwardedTo, "r-20261014-other");
    assert.deepEqual(sc.step(), []);
  });

  it("refuses a route to a request it wasn't given, or without a folder or revision", () => {
    const sc = new Scenario("unrouted", { text: "x" });
    sc.step();
    assert.throws(() => sc.complete("route", { report: { existing: "r-nope", feedback: [] } }), /not one of the active requests/);
    assert.throws(() => sc.complete("route", { report: routed({ kind: "burndown" }) }), /needs a folder/);
    assert.throws(() => sc.complete("route", { report: { feedback: [] } }), /neither existing nor kind/);
    for (const folder of ["/etc", "dom/../../x", ".."]) assert.throws(() => sc.complete("route", { report: routed({ kind: "burndown", folder }) }), /folder/, folder);
    for (const rev of ["abc", "main", "g".repeat(12), "a".repeat(41)]) assert.throws(() => sc.complete("route", { report: routed({ kind: "try-push", rev }) }), /revision/, rev);
  });

  it("when route-request fails twice, asks you to rephrase it in the main box, and the request stays open", () => {
    const sc = new Scenario("unrouted", { text: "hmm" });
    sc.step();
    sc.complete("route", { error: "no result line" });
    sc.step();
    const job = sc.complete("route", { error: "no result line" });
    sc.step();
    const s = sc.state();
    assert.equal(s.step, "request");
    assert.deepEqual(s.needsUser.map((n) => [n.key, n.action]), [[`failed:${job}`, "The factory couldn't tell what this is: rephrase it in the main box"]]);
    assert.deepEqual(sc.step(), []);
  });
});

describe("2. first signal", () => {
  const ann = (condition: string, kind = "skip-if") => ({ manifest: "dom/base/test/mochitest.toml", test: "test_a.html", kind, condition, line: 3, commit: null, bug: { id: 123, summary: "Skip test_a.html", status: "RESOLVED", resolution: "FIXED", firstComment: "fails" }, commentBugs: [] as { id: number }[] });

  function burndown(): Scenario {
    const sc = new Scenario("burndown", { folder: "dom/base/test" });
    sc.step();
    sc.settle();
    return sc;
  }

  function signalWorktree(sc: Scenario): void {
    sc.complete("wt:signal", { output: { name: `${ID}-signal`, path: `/wt/${ID}-signal`, branch: `${ID}-signal` } });
    assert.deepEqual(sc.settle(), ["annotations"]);
  }

  it("lists the skips, classifies each, writes the annotation patches, reviews the run-if and plans the un-skip push", () => {
    const sc = burndown();
    assert.deepEqual(sc.view().jobs.filter((j) => !j.end && !j.purpose.key.startsWith("test-plan:")).map((j) => j.purpose.key), ["wt:signal"]);
    signalWorktree(sc);
    // Listed in the worktree, not in your checkout: it may be days behind.
    assert.deepEqual(sc.plan("annotations").cli?.args, ["list", "dom/base/test", "--repo", `/wt/${ID}-signal`]);
    assert.equal(sc.plan("annotations").cwd, `/wt/${ID}-signal`);
    sc.complete("annotations", { output: [ann("os == 'mac'"), ann("debug", "fail-if"), ann("tsan")] });
    assert.deepEqual(sc.settle().sort(), ["classify:0", "classify:2"]);
    assert.equal(sc.plan("classify:0").name, "classify-annotation");
    assert.deepEqual(sc.plan("classify:0").agent?.vars, {
      annotation: "skip-if = os == 'mac'",
      manifest: "dom/base/test/mochitest.toml [test_a.html]",
      worktree: `/wt/${ID}-signal`,
      commit: "not found",
      bug: "bug 123 (RESOLVED FIXED, “Skip test_a.html”), whose first comment is: fails",
    });
    assert.equal(sc.plan("classify:0").cwd, `/wt/${ID}-signal`);
    sc.complete("classify:0", { report: { kind: "scoping", reason: "no mac", feedback: [] } });
    sc.complete("classify:2", { report: { kind: "flakiness", reason: "races", feedback: [] } });
    assert.deepEqual(sc.settle(), ["author:i-annotations:initial"]);
    const author = sc.plan("author:i-annotations:initial");
    assert.equal(author.name, "write-annotation-patches");
    assert.equal(author.cwd, `/wt/${ID}-signal`);
    const annotations = JSON.parse(author.files![0].content);
    assert.deepEqual(annotations.map((a: { kind: string }) => a.kind), ["scoping", "flakiness"]);
    assert.equal(sc.state().items["i-annotations"].state, "investigating");

    // The run-if commit goes through import, lint and critical review like any fix; the un-skip push doesn't wait.
    sc.complete("author:i-annotations:initial", { report: { runIf: sha("1"), debug: sha("2"), summary: "done", feedback: [] } });
    const authorJob = sc.view().byKey.get("author:i-annotations:initial")![0].job;
    assert.deepEqual(sc.settle(), ["plan:unskip", `import:${authorJob}`]);
    sc.complete(`import:${authorJob}`, { output: imported(sha("1"), "Bug XXXXXXX - Turn scoping skips into run-if, r=jmaher.", ["dom/base/test/mochitest.toml"]) });
    sc.settle();
    sc.complete(`msg:p-annotations:${sha("1")}`, { output: "msg" });
    sc.settle();
    sc.complete(`lint:p-annotations:${sha("1")}`, { output: lintOk });
    assert.deepEqual(sc.settle(), [`review:p-annotations:${authorJob}`]);
    sc.complete(`review:p-annotations:${authorJob}`, { report: ok });
    assert.deepEqual(sc.settle(), []);
    assert.equal(sc.state().items["i-annotations"].state, "reviewed");
    const plan = sc.plan("plan:unskip");
    assert.equal(plan.agent?.vars?.branch, `${ID}-signal`);
    assert.equal(plan.agent?.vars?.failuresFile, "/state/requests/r-20261015-test/data/annotations.json");

    sc.complete("plan:unskip", { report: { pushes: [{ purpose: "reproduce", tryArgs: ["fuzzy", "-q", "xpcshell"], rebuild: 10 }], feedback: [] } });
    assert.deepEqual(sc.settle(), ["dry-run:unskip"]);
    assert.deepEqual(sc.plan("dry-run:unskip").cli?.args, ["dry-run", "--cwd", `/wt/${ID}-signal`, "--pending", `/state/requests/${ID}/data/pending-unskip.json`, "--", "fuzzy", "-q", "xpcshell", "--rebuild", "10"], "its rebuild count, which its arguments didn't say");
    sc.complete("dry-run:unskip", { output: { command: ["./mach", "try", "fuzzy", "-q", "xpcshell"], taskCount: 40, tasks: [], tryTaskConfig: {}, commits: ["c2", "c1"], warnings: ["artifact push"] } });
    sc.settle();
    assert.deepEqual(sc.open(), ["approve-push:unskip"]);
    assert.equal(sc.state().needsUser[0].detail, "40 tasks · reproduce · artifact push");
    assert.equal(sc.state().step, "first signal");

    // Approved: pushed, watched, and the step moves on once the push exists.
    sc.add({ type: "user-done", request: ID, key: "approve-push:unskip" });
    assert.deepEqual(sc.settle(), ["push:unskip"]);
    assert.deepEqual(sc.plan("push:unskip").cli?.args, ["push", "--cwd", `/wt/${ID}-signal`, "--expect-commits", "c2,c1", "--", "fuzzy", "-q", "xpcshell", "--rebuild", "10"]);
    sc.complete("push:unskip", { output: { landoJobId: 7, landoUrl: "l", treeherderUrl: "t" } });
    assert.deepEqual(sc.settle(), ["watch:unskip"]);
    assert.deepEqual(sc.plan("watch:unskip").cli?.args, ["watch", "--lando", "7"]);
    sc.add({ type: "try-pushed", request: ID, push: "unskip", rev: "def", url: "u" });
    sc.settle();
    assert.equal(sc.state().step, "work list");
  });

  it("a skip-if whose comment names a bug is a failure skip, without an agent", () => {
    const sc = burndown();
    signalWorktree(sc);
    sc.complete("annotations", { output: [{ ...ann("tsan"), comment: "Bug 456", commentBugs: [{ id: 456 }] }] });
    assert.deepEqual(sc.settle(), ["author:i-annotations:initial"]);
    const [a] = JSON.parse(sc.plan("author:i-annotations:initial").files![0].content);
    assert.deepEqual([a.kind, a.reason], ["flakiness", "its comment names bug 456"]);
  });

  it("a skip-if added in an Intermittent bug is a failure skip, without an agent", () => {
    const sc = burndown();
    signalWorktree(sc);
    sc.complete("annotations", { output: [{ ...ann("tsan"), bug: { id: 789, summary: "Intermittent test_a.html | timed out", status: "NEW", resolution: "", firstComment: "" } }] });
    assert.deepEqual(sc.settle(), ["author:i-annotations:initial"]);
    assert.equal(JSON.parse(sc.plan("author:i-annotations:initial").files![0].content)[0].kind, "flakiness");
  });

  it("otherwise, the classify agent reads the commit and bug in the signal worktree", () => {
    const sc = burndown();
    signalWorktree(sc);
    const commit = { sha: "0123456789abcdef", date: "2024-03-05T10:00:00Z", author: "A", subject: "Bug 123 - Convert to toml" };
    sc.complete("annotations", { output: [{ ...ann("asan"), comment: "slow", commit, bug: { id: 123 } }] });
    assert.deepEqual(sc.settle(), ["classify:0"]);
    assert.equal(sc.plan("classify:0").cwd, `/wt/${ID}-signal`);
    assert.deepEqual(sc.plan("classify:0").agent?.vars, {
      annotation: "skip-if = asan # slow",
      manifest: "dom/base/test/mochitest.toml [test_a.html]",
      worktree: `/wt/${ID}-signal`,
      commit: "0123456789ab (2024-03-05, “Bug 123 - Convert to toml”)",
      bug: "bug 123",
    });
  });

  it("without skip-ifs, the work list comes from the folder's history on central", () => {
    const sc = burndown();
    signalWorktree(sc);
    sc.complete("annotations", { output: [ann("debug", "fail-if")] });
    assert.deepEqual(sc.settle(), ["collect:folder:folder"]);
    assert.equal(sc.state().step, "work list");
    assert.deepEqual(sc.plan("collect:folder:folder").cli?.args, ["collect", "dom/base/test"]);
  });

  it("redone at investigate and fix, lists and classifies today's skip-ifs, reruns the author and plans the un-skip push, without a step event", () => {
    const sc = burndown();
    signalWorktree(sc);
    sc.complete("annotations", { output: [ann("tsan")] });
    sc.settle();
    sc.complete("classify:0", { report: { kind: "flakiness", reason: "races", feedback: [] } });
    assert.deepEqual(sc.settle(), ["author:i-annotations:initial"]);
    // No DEBUG commit: the group closes and the work list comes from central.
    sc.complete("author:i-annotations:initial", { report: { summary: "the skip-if was already gone", feedback: [] } });
    sc.settle();
    assert.equal(sc.state().step, "work list");
    sc.complete("collect:folder:folder", { output: [failure("dom/base/test/test_b.html", "boom")] });
    sc.settle();
    sc.complete("cluster:folder:folder", { output: { groups: [group("kb", "dom/base/test/test_b.html", "boom")], singles: [] } });
    sc.settle();
    assert.equal(sc.state().step, "investigate and fix");
    const closed = sc.state().items["i-annotations"].state;
    assert.ok(["left as-is", "fixed", "handed back", "landed"].includes(closed), closed);
    const steps = sc.of("step").length;

    sc.add({ type: "item-state", request: ID, item: "i-annotations", state: "not started", detail: "redone with today's skip-ifs" });
    // A fresh worktree: the first one is as old as the request.
    assert.ok(sc.settle().includes("wt:signal@1"));
    sc.complete("wt:signal@1", { output: { name: `${ID}-signal-1`, path: `/wt/${ID}-signal-1`, branch: `${ID}-signal-1` } });
    assert.ok(sc.settle().includes("annotations@1"));
    assert.deepEqual(sc.plan("annotations@1").cli?.args, ["list", "dom/base/test", "--repo", `/wt/${ID}-signal-1`]);
    sc.complete("annotations@1", { output: [ann("tsan"), ann("asan")] });
    assert.deepEqual(sc.settle().filter((k) => k.startsWith("classify")).sort(), ["classify:0@1", "classify:1@1"]);
    sc.complete("classify:0@1", { report: { kind: "flakiness", reason: "races", feedback: [] } });
    sc.complete("classify:1@1", { report: { kind: "flakiness", reason: "races", feedback: [] } });
    // Started once every skip-if is classified, not as soon as the group is reset.
    assert.ok(sc.settle().includes("author:i-annotations@1:initial"));
    const author = sc.plan("author:i-annotations@1:initial");
    assert.equal(author.cwd, `/wt/${ID}-signal-1`);
    assert.equal(JSON.parse(author.files![0].content).length, 2);
    sc.complete("author:i-annotations@1:initial", { report: { debug: sha("9"), summary: "un-skip", feedback: [] } });
    assert.ok(sc.settle().includes("plan:unskip@1"));
    assert.equal(sc.plan("plan:unskip@1").agent?.vars?.branch, `${ID}-signal-1`);
    sc.complete("plan:unskip@1", { report: { pushes: [{ purpose: "reproduce", tryArgs: ["fuzzy", "-q", "xpcshell"], rebuild: 10 }], feedback: [] } });
    assert.ok(sc.settle().includes("dry-run:unskip-1"));
    sc.complete("dry-run:unskip-1", { output: { command: ["./mach", "try", "fuzzy"], taskCount: 4, tasks: [], tryTaskConfig: {}, commits: [sha("9")], warnings: [] } });
    sc.settle();
    assert.ok(sc.open().includes("approve-push:unskip-1"));
    sc.add({ type: "user-done", request: ID, key: "approve-push:unskip-1" });
    sc.settle();
    sc.add({ type: "try-pushed", request: ID, push: "unskip-1", rev: "def", url: "u" });
    sc.settle();
    assert.equal(sc.state().step, "investigate and fix");
    assert.equal(sc.of("step").length, steps);
  });
});

describe("try pushes", () => {
  it("fetches the artifacts of each failed job as it arrives, once", () => {
    const sc = new Scenario("try-push", { rev: "abc" });
    sc.step();
    sc.settle();
    sc.add({ type: "try-job-failed", request: ID, push: "initial", taskId: "T1", retryId: 0, jobName: "j", platform: "p", result: "testfailed" });
    assert.deepEqual(sc.step(), ["artifacts:T1:0"]);
    assert.deepEqual(sc.plan("artifacts:T1:0").cli?.args, ["fetch", "T1", "--run", "0", "--into", "/state/cache/artifacts/T1"]);
    assert.deepEqual(sc.step(), []);
  });
});

describe("try pushes, failing", () => {
  it("never retries a failed push by itself: it may have pushed", () => {
    const sc = new Scenario("try-push", { rev: "abc" });
    sc.step();
    sc.settle();
    sc.add({ type: "try-planned", request: ID, push: "A", purpose: "p", command: ["./mach", "try", "fuzzy"] });
    sc.startJob({ purpose: { key: "dry-run:A", what: "dry-run", push: "A", args: ["fuzzy", "-q", "x"], cwd: "/wt/s" }, kind: "script", name: "try.ts dry-run", cwd: "/wt/s", cli: { tool: "try.ts", args: [] } });
    sc.complete("dry-run:A", { output: { command: ["./mach", "try", "fuzzy"], taskCount: 1, tasks: [], tryTaskConfig: {}, commits: ["c1"], warnings: [] } });
    sc.add({ type: "user-done", request: ID, key: "approve-push:A" });
    assert.deepEqual(sc.settle(), ["push:A"]);
    const job = sc.complete("push:A", { exitCode: 1, error: "Lando timed out" });
    assert.deepEqual(sc.settle(), []);
    assert.deepEqual(sc.open(), [`failed:${job}`]);
    assert.match(sc.state().needsUser[0].action, /not retried/);
  });

  it("asks for a new plan when the push was refused because the stack changed since its dry run", () => {
    const sc = new Scenario("try-push", { rev: "abc" });
    sc.step();
    sc.settle();
    sc.add({ type: "try-planned", request: ID, push: "A", purpose: "p", command: ["./mach", "try", "fuzzy"] });
    sc.startJob({ purpose: { key: "dry-run:A", what: "dry-run", push: "A", args: ["fuzzy", "-q", "x"], cwd: "/wt/s" }, kind: "script", name: "try.ts dry-run", cwd: "/wt/s", cli: { tool: "try.ts", args: [] } });
    sc.complete("dry-run:A", { output: { command: ["./mach", "try", "fuzzy"], taskCount: 1, tasks: [], tryTaskConfig: {}, commits: ["a"], warnings: [] } });
    sc.add({ type: "user-done", request: ID, key: "approve-push:A" });
    sc.settle();
    const job = sc.complete("push:A", { exitCode: 1, error: "not pushed: commits changed since the approved dry run: expected a, found b" });
    assert.deepEqual(sc.settle(), []);
    assert.deepEqual(sc.open(), [`failed:${job}`]);
    assert.match(sc.state().needsUser[0].action, /^Push A not made: the stack's code changed since its dry run/);
  });
});

describe("3. work list", () => {
  it("runs when the push finishes: results table, failures, clusters, merge, items, then step 4", () => {
    const sc = tryPushFinished();
    assert.deepEqual(sc.step().sort(), ["collect:initial:final", "try-table:initial:final"]);
    sc.complete("try-table:initial:final", { output: table() });
    sc.complete("collect:initial:final", { output: [failure("a/test_a.js", "boom"), failure("b/test_b.js", "bang")] });
    assert.deepEqual(sc.step(), ["cluster:initial:final"]);
    assert.deepEqual(sc.plan("cluster:initial:final").cli?.args, ["cluster", `/state/jobs/${sc.view().byKey.get("collect:initial:final")![0].job}/out.log`]);
    sc.complete("cluster:initial:final", {
      output: { groups: [group("ka", "a/test_a.js", "boom", 2), group("kb", "b/test_b.js", "boom 2")], singles: [group("kc", "c/browser_c.js", "Test timed out")] },
    });
    assert.deepEqual(sc.step(), ["merge:initial:final"]);
    // Singles are never merged: merge-clusters only sees the groups.
    const merge = sc.plan("merge:initial:final");
    assert.deepEqual(merge.files?.map((f) => f.path), [merge.agent?.vars?.clustersFile]);
    assert.deepEqual(JSON.parse(merge.files![0].content).groups.map((g: { key: string }) => g.key), ["ka", "kb"]);
    sc.complete("merge:initial:final", {
      report: { groups: [{ message: "boom", tests: ["a/test_a.js", "b/test_b.js"], configs: ["c"], from: ["ka", "kb"], reason: "same crash" }], feedback: [] },
    });
    sc.step();
    const s = sc.state();
    assert.equal(s.step, "investigate and fix");
    assert.deepEqual(Object.keys(s.items), ["i-test-a", "i-browser-c"]);
    assert.equal(s.items["i-test-a"].folder, "a");
    assert.equal(s.items["i-test-a"].group.ratePerWeek, 3);
    assert.deepEqual(s.items["i-test-a"].group.tests, ["a/test_a.js", "b/test_b.js"]);
    assert.equal(s.items["i-browser-c"].group.message, "Test timed out");
  });

  it("makes items of one group and the singles without merge-clusters", () => {
    const sc = tryPushFinished();
    sc.step();
    sc.complete("try-table:initial:final", { output: table() });
    sc.complete("collect:initial:final", { output: [failure("a/test_a.js", "boom"), failure("b/test_b.js", "Test timed out"), failure("c/test_c.js", "Test timed out")] });
    sc.step();
    sc.complete("cluster:initial:final", { output: { groups: [group("ka", "a/test_a.js", "boom")], singles: [group("kt", "b/test_b.js", "Test timed out"), group("kt", "c/test_c.js", "Test timed out")] } });
    assert.ok(!sc.settle().some((k) => k.startsWith("merge:")));
    assert.deepEqual(Object.keys(sc.state().items).sort(), ["i-test-a", "i-test-b", "i-test-c"]);
  });

  it("adds no item for a single that an earlier version's merge report folded into a group", () => {
    const sc = tryPushFinished();
    sc.step();
    sc.complete("try-table:initial:final", { output: table() });
    sc.complete("collect:initial:final", { output: [failure("a/test_a.js", "boom"), failure("b/test_b.js", "bang"), failure("c/browser_c.js", "Test timed out")] });
    sc.step();
    sc.complete("cluster:initial:final", { output: { groups: [group("ka", "a/test_a.js", "boom"), group("kb", "b/test_b.js", "bang")], singles: [group("kc", "c/browser_c.js", "Test timed out")] } });
    sc.step();
    // Recorded by an earlier version, which sent the singles too: no check of its tests.
    const job = sc.running("merge:initial:final");
    const report = {
      groups: [
        { message: "boom", tests: ["a/test_a.js", "c/browser_c.js"], configs: [], from: ["ka", "kc"], reason: "same" },
        { message: "bang", tests: ["b/test_b.js"], configs: [], from: ["kb"], reason: "unchanged" },
      ],
      feedback: [],
    };
    sc.reports.set(job, report);
    sc.add({ type: "agent-report", request: ID, job, prompt: "merge-clusters", report });
    sc.add({ type: "job-finished", request: ID, job, exitCode: 0, durationMs: 1 });
    sc.settle();
    assert.deepEqual(Object.keys(sc.state().items), ["i-test-a", "i-test-b"]);
    assert.deepEqual(sc.state().items["i-test-a"].group.tests, ["a/test_a.js", "c/browser_c.js"]);
  });

  it("rejects a merge-clusters report that drops or adds a test: one retry with the error, then it comes to you", () => {
    const sc = tryPushFinished();
    sc.step();
    sc.complete("try-table:initial:final", { output: table() });
    sc.complete("collect:initial:final", { output: [failure("a/test_a.js", "boom"), failure("b/test_b.js", "bang")] });
    sc.step();
    sc.complete("cluster:initial:final", { output: { groups: [group("ka", "a/test_a.js", "boom"), group("kb", "b/test_b.js", "bang")], singles: [] } });
    sc.step();
    const dropped = { groups: [{ message: "boom", tests: ["a/test_a.js"], configs: [], from: ["ka"], reason: "unchanged" }], feedback: [] };
    assert.throws(() => sc.complete("merge:initial:final", { report: dropped }), (e: Error) => e instanceof InvalidReport && /missing from your groups: b\/test_b\.js/.test(e.message));
    const added = { groups: [{ message: "boom", tests: ["a/test_a.js", "b/test_b.js", "z/test_z.js"], configs: [], from: ["ka", "kb"], reason: "same" }], feedback: [] };
    assert.throws(() => sc.complete("merge:initial:final", { report: added }), /weren't in the input groups: z\/test_z\.js/);
    assert.deepEqual(sc.of("agent-report"), []);
    // What the runner records for it.
    sc.complete("merge:initial:final", { error: "invalid report: tests missing from your groups: b/test_b.js" });
    assert.deepEqual(sc.step(), ["merge:initial:final"]);
    const retry = sc.plan("merge:initial:final");
    assert.equal(retry.agent?.resume, true);
    assert.match(retry.agent?.message ?? "", /tests missing from your groups: b\/test_b\.js/);
    sc.complete("merge:initial:final", { error: "invalid report: tests missing from your groups: b/test_b.js" });
    sc.step();
    assert.ok(sc.open()[0].startsWith("failed:"));
    assert.deepEqual(Object.keys(sc.state().items), []);
  });

  // The clusters of tryPushFinished: two groups failing on different configs and tasks.
  function clustered(): Scenario {
    const sc = tryPushFinished();
    sc.step();
    sc.complete("try-table:initial:final", { output: table() });
    sc.complete("collect:initial:final", { output: [failure("a/test_a.js", "boom"), failure("b/test_b.js", "bang")] });
    sc.step();
    sc.complete("cluster:initial:final", {
      output: {
        groups: [
          { ...group("ka", "a/test_a.js", "boom", 2), configs: ["win/debug-xpcshell", "linux/opt-xpcshell"], taskIds: ["T1", "T2"] },
          { ...group("kb", "b/test_b.js", "bang", 1.5), configs: ["linux/opt-xpcshell", "mac/opt-xpcshell"], taskIds: ["T2", "T3"] },
        ],
        singles: [],
      },
    });
    sc.step();
    return sc;
  }

  it("takes a merged group's configs, rate and task ids from the clusters it merges, never from the agent", () => {
    const sc = clustered();
    sc.complete("merge:initial:final", {
      report: { groups: [{ message: "boom", tests: ["a/test_a.js", "b/test_b.js"], configs: ["every/folder-config"], from: ["ka", "kb"], reason: "same crash" }], feedback: [] },
    });
    sc.step();
    const g = sc.state().items["i-test-a"].group;
    assert.deepEqual(g.configs, ["linux/opt-xpcshell", "mac/opt-xpcshell", "win/debug-xpcshell"]);
    assert.equal(g.ratePerWeek, 3.5);
    assert.deepEqual(g.taskIds, ["T1", "T2", "T3"]);
  });

  it("rejects a merge-clusters report whose `from` names clusters that don't exist", () => {
    const sc = clustered();
    const report = { groups: [{ message: "boom", tests: ["a/test_a.js", "b/test_b.js"], configs: [], from: ["ka", "nope", "nope"], reason: "same" }], feedback: [] };
    assert.throws(
      () => sc.complete("merge:initial:final", { report }),
      (e: Error) => e instanceof InvalidReport && /`from` names clusters that don't exist: nope \(use the input groups' `key` values\)/.test(e.message) && !/missing|weren't/.test(e.message),
    );
    assert.deepEqual(sc.of("agent-report"), []);
  });

  it("takes the configs of a merged group that names no existing cluster from the clusters of its tests", () => {
    const sc = clustered();
    // Recorded before unknown keys were rejected.
    const job = sc.running("merge:initial:final");
    const report = {
      groups: [
        { message: "boom", tests: ["a/test_a.js"], configs: ["every/folder-config"], from: ["a/test_a.js"], reason: "unchanged" },
        { message: "bang", tests: ["b/test_b.js"], configs: ["every/folder-config"], from: ["kb", "gone"], reason: "unchanged" },
      ],
      feedback: [],
    };
    sc.reports.set(job, report);
    sc.add({ type: "agent-report", request: ID, job, prompt: "merge-clusters", report });
    sc.add({ type: "job-finished", request: ID, job, exitCode: 0, durationMs: 1 });
    sc.settle();
    const { items } = sc.state();
    assert.deepEqual(items["i-test-a"].group.configs, ["linux/opt-xpcshell", "win/debug-xpcshell"]);
    assert.equal(items["i-test-a"].group.ratePerWeek, 2);
    assert.deepEqual(items["i-test-a"].group.taskIds, ["T1", "T2"]);
    // One named cluster exists: only it counts.
    assert.deepEqual(items["i-test-b"].group.configs, ["linux/opt-xpcshell", "mac/opt-xpcshell"]);
  });

  it("takes a merged group naming no existing cluster from those of its tests whose message is alike", () => {
    const sc = tryPushFinished();
    sc.step();
    sc.complete("try-table:initial:final", { output: table() });
    sc.complete("collect:initial:final", { output: [failure("a/test_a.js", "x")] });
    sc.step();
    sc.complete("cluster:initial:final", {
      output: {
        groups: [
          { ...group("k1", "a/test_a.js", "Waiting for example.org entry is in BFCache", 2), configs: ["win/debug-xpcshell"], taskIds: ["T1"] },
          { ...group("k2", "a/test_a.js", "sw-error: registration failed", 5), configs: ["mac/opt-xpcshell"], taskIds: ["T2"] },
        ],
        singles: [],
      },
    });
    sc.step();
    const job = sc.running("merge:initial:final");
    // Recorded before unknown keys were rejected.
    const report = { groups: [{ message: "Waiting for * entry is in BFCache", tests: ["a/test_a.js"], configs: ["every/folder-config"], from: ["gone"], reason: "r" }], feedback: [] };
    sc.reports.set(job, report);
    sc.add({ type: "agent-report", request: ID, job, prompt: "merge-clusters", report });
    sc.add({ type: "job-finished", request: ID, job, exitCode: 0, durationMs: 1 });
    sc.settle();
    const g = sc.state().items["i-test-a"].group;
    assert.deepEqual(g.configs, ["win/debug-xpcshell"]);
    assert.equal(g.ratePerWeek, 2);
    assert.deepEqual(g.taskIds, ["T1"]);
  });

  it("runs at 2 h when the push hasn't finished, then again when it finishes, adding only new groups", () => {
    const sc = new Scenario("try-push", { rev: "abc" });
    sc.step();
    sc.settle();
    sc.now += HOUR;
    assert.deepEqual(sc.step(), []);
    sc.now += HOUR;
    assert.deepEqual(sc.step().sort(), ["collect:initial:early", "try-table:initial:early"]);
    sc.complete("try-table:initial:early", { output: table() });
    sc.complete("collect:initial:early", { output: [failure("a/test_a.js", "boom")] });
    sc.step();
    sc.complete("cluster:initial:early", { output: { groups: [group("ka", "a/test_a.js", "boom")], singles: [] } });
    sc.settle();
    assert.deepEqual(Object.keys(sc.state().items), ["i-test-a"]);
    assert.equal(sc.state().step, "investigate and fix");

    sc.add({ type: "try-finished", request: ID, push: "initial", result: "failures", summary: "s" });
    assert.ok(sc.step().includes("collect:initial:final"));
    sc.complete("try-table:initial:final", { output: table() });
    sc.complete("collect:initial:final", { output: [failure("a/test_a.js", "boom"), failure("b/test_b.js", "bang")] });
    sc.step();
    sc.complete("cluster:initial:final", { output: { groups: [group("ka", "a/test_a.js", "boom"), group("kb", "b/test_b.js", "bang")], singles: [] } });
    sc.step();
    sc.complete("merge:initial:final", { report: { groups: [{ message: "boom", tests: ["a/test_a.js"], configs: [], from: ["ka"], reason: "unchanged" }, { message: "bang", tests: ["b/test_b.js"], configs: [], from: ["kb"], reason: "unchanged" }], feedback: [] } });
    sc.step();
    assert.deepEqual(Object.keys(sc.state().items), ["i-test-a", "i-test-b"]);
  });

  it("runs early once half the requested test tasks finished, without waiting 2 h", () => {
    const sc = new Scenario("try-push", { rev: "abc" });
    sc.step();
    sc.settle();
    sc.now += HOUR / 2;
    // Treeherder's job count would say half, but the test tasks say otherwise.
    sc.add({ type: "try-progress", request: ID, push: "initial", done: 30, total: 50, failures: 1, tests: { done: 9, total: 20 } });
    assert.deepEqual(sc.step(), []);
    sc.add({ type: "try-progress", request: ID, push: "initial", done: 31, total: 50, failures: 1, tests: { done: 10, total: 20 } });
    assert.deepEqual(sc.step().sort(), ["collect:initial:early", "try-table:initial:early"]);
  });

  it("without the requested test tasks, runs early once half of Treeherder's jobs finished", () => {
    const sc = new Scenario("try-push", { rev: "abc" });
    sc.step();
    sc.settle();
    sc.add({ type: "try-progress", request: ID, push: "initial", done: 24, total: 50, failures: 1 });
    assert.deepEqual(sc.step(), []);
    sc.add({ type: "try-progress", request: ID, push: "initial", done: 25, total: 50, failures: 1 });
    assert.deepEqual(sc.step().sort(), ["collect:initial:early", "try-table:initial:early"]);
  });

  it("triages the jobs fx-tests couldn't parse: new failures become items, the rest is noted", () => {
    const sc = tryPushFinished();
    sc.step();
    sc.complete("try-table:initial:final", { output: table([], [{ taskId: "T9", retryId: 0, jobName: "j", config: "c", result: "busted", reason: "crash" }]) });
    sc.complete("collect:initial:final", { output: [] });
    assert.deepEqual(sc.step(), ["triage:initial:final"]);
    assert.equal(sc.plan("triage:initial:final").agent?.vars?.logsDir, "/state/cache/artifacts");
    sc.complete("triage:initial:final", {
      report: {
        cells: [
          { test: "c/test_c.js", config: "linux", verdict: "still failing", evidence: "TEST-UNEXPECTED-FAIL | c/test_c.js | crash" },
          { taskId: "T8", verdict: "infra", evidence: "worker lost" },
        ],
        feedback: [],
      },
    });
    sc.step();
    assert.deepEqual(Object.keys(sc.state().items), ["i-test-c"]);
    assert.match(sc.of("note")[0].text, /^Infra failures/);
    assert.equal(sc.state().step, "investigate and fix");
  });

  it("ends the request when there's nothing to fix", () => {
    const sc = tryPushFinished();
    sc.step();
    sc.complete("try-table:initial:final", { output: table() });
    sc.complete("collect:initial:final", { output: [] });
    sc.step();
    assert.equal(sc.state().step, "done");
  });
});

describe("4. investigate and fix", () => {
  it("someone active: take-it waits for you, take it lets the item go on", () => {
    const sc = workList([group("ka", "a/test_a.js", "boom")]);
    assert.deepEqual(sc.view().jobs.filter((j) => !j.end && !j.purpose.key.startsWith("test-plan:")).map((j) => j.purpose.key), ["prior-art:i-test-a"]);
    sc.complete("prior-art:i-test-a", { output: { bugs: [] } });
    sc.settle();
    assert.match(String(sc.plan("prior-art-verdict:i-test-a").agent?.vars?.facts), /^in \/state\/jobs\/j-\d+\/out.log$/);
    sc.complete("prior-art-verdict:i-test-a", { report: { verdict: "active", quote: "revision in review by janv", feedback: [] } });
    assert.deepEqual(sc.settle(), []);
    assert.deepEqual(sc.open(), ["take-it:i-test-a"]);
    sc.add({ type: "user-done", request: ID, key: "take-it:i-test-a" });
    assert.deepEqual(sc.settle(), ["wt:i-test-a"]);
    const wt = sc.plan("wt:i-test-a");
    assert.equal(wt.kind, "build");
    assert.deepEqual(wt.cli?.args, ["create", `${ID}-i-test-a`, "--base", "origin/main", "--build", "artifact"]);
  });

  it("two groups of one test that haven't started are one: the first gets both failures, the second closes", () => {
    const sc = workList([group("ka", "a/test_a.js", "boom"), { ...group("kb", "a/test_a.js", "bang"), configs: ["mac/opt-xpcshell"], taskIds: ["T2"] }]);
    assert.equal(sc.state().items["i-test-a-2"].state, "left as-is");
    const g = sc.state().items["i-test-a"].group;
    assert.equal(g.message, "boom | bang");
    assert.deepEqual(g.configs, ["linux/opt-xpcshell", "mac/opt-xpcshell"]);
    assert.deepEqual(g.taskIds, ["T1", "T2"]);
    assert.deepEqual(sc.view().jobs.filter((j) => !j.end && !j.purpose.key.startsWith("test-plan:")).map((j) => j.purpose.key), ["prior-art:i-test-a"]);
  });

  it("a request has as many groups investigating in worktrees as it can run agents (4 here); reviewed ones don't count", () => {
    const tests = ["a", "b", "c", "d", "e", "f"];
    const sc = workList(tests.map((t) => group(`k${t}`, `a/test_${t}.js`, "boom")));
    for (const t of tests) sc.complete(`prior-art:i-test-${t}`, { output: { bugs: [] } });
    sc.settle();
    for (const t of tests) sc.complete(`prior-art-verdict:i-test-${t}`, { report: none });
    assert.deepEqual(sc.settle().sort(), ["wt:i-test-a", "wt:i-test-b", "wt:i-test-c", "wt:i-test-d"]);
    sc.complete("wt:i-test-a", { output: { name: `${ID}-i-test-a`, path: `/wt/${ID}-i-test-a`, branch: `${ID}-i-test-a` } });
    sc.settle();
    reviewed(sc, "i-test-a", "c1", "a/test_a.js");
    assert.ok(sc.view().byKey.has("wt:i-test-e"), "a's fix is reviewed: e gets its worktree");
    assert.ok(!sc.view().byKey.has("wt:i-test-f"));
  });

  it("a test's group found after its first group started joins it, and the first group's author is told once its run ends", () => {
    const sc = workList([group("ka", "a/test_a.js", "boom")]);
    investigating(sc, "i-test-a");
    // A group found later (a try push's triage…), once the first one's author started.
    sc.add({ type: "item-created", request: ID, item: "i-test-a-2", folder: "a", group: { ...group("kb", "a/test_a.js", "bang"), configs: ["mac/opt-xpcshell"] } } as never);
    sc.settle();
    assert.equal(sc.state().items["i-test-a-2"].state, "left as-is");
    assert.deepEqual(sc.state().items["i-test-a"].group.late, ["bang"]);
    assert.deepEqual(Object.keys(sc.state().items), ["i-test-a", "i-test-a-2"], "boom isn't found again as a new group");
    sc.complete("author:i-test-a:initial", { report: fixed(["c1"]) });
    const started = sc.settle();
    const late = started.find((k) => k.startsWith("author:i-test-a:late:"))!;
    assert.ok(late, String(started));
    assert.ok(!started.some((k) => k.startsWith("import:")), "the fix waits for the author's answer");
    assert.match(sc.plan(late).agent?.message ?? "", /also failed with: "bang" \(the test's failures are now on linux\/opt-xpcshell, mac\/opt-xpcshell/);
    sc.complete(late, { report: fixed(["c2"]) });
    const next = sc.view().byKey.get(late)![0].job;
    assert.ok(sc.settle().includes(`import:${next}`), "told once");
  });

  it("gives each bug draft to the commits it's for: 3 patches, 2 bugs; filing one sets it on all the patches it's for", () => {
    const sc = workList([group("ka", "a/test_a.js", "boom", 2)]);
    investigating(sc, "i-test-a");
    const product = { product: "Core", component: "DOM: Navigation", summary: "Fix", description: "d", bugType: "defect" };
    const harness = { product: "Testing", component: "Mochitest", summary: "Leak paths", description: "d", bugType: "enhancement" };
    sc.complete("author:i-test-a:initial", { report: fixed([sha("1"), sha("2"), sha("3")], { bugDrafts: [{ commits: [sha("1").slice(0, 12), sha("2").slice(0, 12)], draft: product }, { commits: [sha("3")], draft: harness }] }) });
    const job = sc.view().byKey.get("author:i-test-a:initial")![0].job;
    sc.settle();
    sc.complete(`import:${job}`, {
      output: [...imported(sha("1"), "Bug XXXXXXX - Part 1, r=a.", ["a.cpp"]), ...imported(sha("2"), "Bug XXXXXXX - Part 2, r=a.", ["b.cpp"]), ...imported(sha("3"), "Bug XXXXXXX - Leak paths, r=b.", ["c.py"])],
    });
    const p = sc.state().patches;
    assert.deepEqual([p["p-test-a"].bugDraft, p["p-test-a-2"].bugDraft, p["p-test-a-3"].bugDraft], [product, product, harness]);
    assert.deepEqual(sc.settle().filter((k) => k.startsWith("lint-bug:")).sort(), [`lint-bug:${job}`, `lint-bug:${job}:1`]);
    for (const e of commandEffects({ v: 1, id: "c-bug", t: "2026-10-15T09:00:00.000Z", request: ID, cmd: "set-bug", patch: "p-test-a-2", bug: 777 } as Command, { config, state: sc.state(), view: sc.view(), exists: () => false, plan: () => undefined })) {
      if (e.type === "event") sc.add(e.event);
    }
    const after = sc.state().patches;
    assert.deepEqual([after["p-test-a"].bug, after["p-test-a-2"].bug, after["p-test-a-3"].bug], [777, 777, null]);
  });

  it("investigates in the worktree, imports the commits, lints, reviews; a bug draft doesn't ask you to file it yet", () => {
    const sc = workList([group("ka", "a/test_a.js", "boom", 2)]);
    investigating(sc, "i-test-a");
    const author = sc.plan("author:i-test-a:initial");
    assert.equal(author.name, "investigate-and-fix");
    assert.equal(author.cwd, `/wt/${ID}-i-test-a`);
    assert.equal(author.agent?.resume, false);
    assert.match(String(author.agent?.vars?.failureSummary), /^"boom" on 1 configs, 2 failures\/week; the full group, with its configs and task ids, is in \/state\/requests\/.*\/data\/items\/i-test-a.json\.$/);
    assert.equal(sc.state().items["i-test-a"].state, "investigating");

    const draft = { product: "Core", component: "XPCOM", summary: "s", description: "d" };
    sc.complete("author:i-test-a:initial", { report: fixed([sha("1")], { bugDraft: draft, landsAfter: [{ what: "D123", reason: "uses its helper" }] }) });
    assert.equal(sc.state().items["i-test-a"].state, "fix verified locally");
    const job = sc.view().byKey.get("author:i-test-a:initial")![0].job;
    assert.deepEqual(sc.settle(), [`import:${job}`]);
    assert.deepEqual(sc.plan(`import:${job}`).cli?.args, ["import", "--cwd", `/wt/${ID}-i-test-a`, `${sha("1")}^..${sha("1")}`]);
    sc.complete(`import:${job}`, { output: imported(sha("1"), "Bug XXXXXXX - Fix test_a, r=smaug.", ["a/test_a.js"]) });
    const patch = sc.state().patches["p-test-a"];
    assert.equal(patch.bug, null);
    assert.deepEqual(patch.bugDraft, draft);
    assert.deepEqual(patch.deps.map((d) => d.needs), ["D123"]);
    assert.deepEqual(sc.settle().sort(), [`lint-bug:${job}`, `msg:p-test-a:${sha("1")}`]);
    sc.complete(`msg:p-test-a:${sha("1")}`, { output: "Bug XXXXXXX - Fix\n" });
    assert.deepEqual(sc.settle(), [`lint:p-test-a:${sha("1")}`]);
    sc.complete(`lint:p-test-a:${sha("1")}`, { output: lintOk });
    sc.complete(`lint-bug:${job}`, { output: lintOk });
    assert.deepEqual(sc.settle(), [`review:p-test-a:${job}`]);
    assert.deepEqual(sc.open(), []);
    const review = sc.plan(`review:p-test-a:${job}`);
    assert.deepEqual(review.agent?.vars, { sha: sha("1"), worktree: `/wt/${ID}-i-test-a`, report: `/state/requests/${ID}/reports/${job}.json`, comments: "" });
    assert.notEqual(review.agent?.sessionId, author.agent?.sessionId);
    assert.equal(sc.state().items["i-test-a"].state, "in critical review");
    sc.complete(`review:p-test-a:${job}`, { report: ok });
    sc.settle();
    assert.equal(sc.state().items["i-test-a"].state, "reviewed");
  });

  it("lint violations go back to the author at most twice, then come to you", () => {
    const sc = workList([group("ka", "a/test_a.js", "boom")]);
    investigating(sc, "i-test-a");
    const session = sc.plan("author:i-test-a:initial").agent!.sessionId;
    let author = "author:i-test-a:initial";
    for (let round = 0; round < 3; round++) {
      const commit = sha(String(round + 1));
      sc.complete(author, { report: fixed([commit]) });
      sc.settle();
      const job = sc.view().byKey.get(author)!.at(-1)!.job;
      sc.complete(`import:${job}`, { output: imported(commit, "Bug 1 - Fix", ["a/test_a.js"], 1) });
      sc.settle();
      sc.complete(`msg:p-test-a:${commit}`, { output: "m" });
      sc.settle();
      sc.complete(`lint:p-test-a:${commit}`, { output: { ok: false, violations: [{ rule: "noHedging", line: 3, text: "probably" }] } });
      const started = sc.settle();
      if (round < 2) {
        author = `author:i-test-a:lint:${job}`;
        assert.deepEqual(started, [author]);
        const plan = sc.plan(author);
        assert.equal(plan.agent?.resume, true);
        assert.equal(plan.agent?.sessionId, session);
        assert.equal(plan.name, "investigate-and-fix");
        assert.match(plan.agent?.message ?? "", /noHedging \(line 3\): probably/);
      } else {
        assert.deepEqual(started, []);
        assert.ok(sc.open()[0].startsWith("failed:"));
        assert.equal(sc.state().items["i-test-a"].state, "blocked");
      }
    }
  });

  it("a fix without a bug or a draft goes back to its author once, before anything else; with a draft it goes on", () => {
    const sc = workList([group("ka", "a/test_a.js", "boom")]);
    investigating(sc, "i-test-a");
    sc.complete("author:i-test-a:initial", { report: fixed([sha("1")]) });
    sc.settle();
    const job = sc.view().byKey.get("author:i-test-a:initial")![0].job;
    sc.complete(`import:${job}`, { output: imported(sha("1"), "Bug XXXXXXX - Fix test_a, r=smaug.", ["a/test_a.js"]) });
    const resumed = `author:i-test-a:bug:${job}`;
    assert.deepEqual(sc.settle(), [resumed]);
    const plan = sc.plan(resumed);
    assert.equal(plan.agent?.resume, true);
    assert.match(plan.agent?.message ?? "", /no bug: only annotation patches go under the meta bug/);
    assert.ok(![...sc.view().byKey.keys()].some((k) => k.startsWith("msg:") || k.startsWith("lint:") || k.startsWith("review:")));
    sc.complete(resumed, { report: fixed([sha("2")], { bugDraft }) });
    sc.settle();
    const again = sc.view().byKey.get(resumed)![0].job;
    sc.complete(`import:${again}`, { output: imported(sha("2"), "Bug XXXXXXX - Fix test_a, r=smaug.", ["a/test_a.js"]) });
    assert.deepEqual(sc.settle().sort(), [`lint-bug:${again}`, `msg:p-test-a:${sha("2")}`]);
    sc.complete(`msg:p-test-a:${sha("2")}`, { output: "Bug XXXXXXX - Fix\n" });
    sc.complete(`lint-bug:${again}`, { output: lintOk });
    assert.deepEqual(sc.settle(), [`lint:p-test-a:${sha("2")}`]);
    sc.complete(`lint:p-test-a:${sha("2")}`, { output: lintOk });
    assert.deepEqual(sc.settle(), [`review:p-test-a:${again}`]);
  });

  it("a reworded commit whose code a review accepted gets the lint again, no new critical review; changed code does", () => {
    for (const code of ["P1", "P2"]) {
      const sc = workList([group("ka", "a/test_a.js", "boom")]);
      investigating(sc, "i-test-a");
      const withCode = (c: string, patchId: string) => imported(c, "Bug 7 - Fix test_a, r=smaug.", ["a/test_a.js"], 7).map((x) => ({ ...x, patchId }));
      sc.complete("author:i-test-a:initial", { report: fixed([sha("1")]) });
      sc.settle();
      const first = sc.view().byKey.get("author:i-test-a:initial")![0].job;
      sc.complete(`import:${first}`, { output: withCode(sha("1"), "P1") });
      sc.settle();
      sc.complete(`msg:p-test-a:${sha("1")}`, { output: "Bug 7 - Fix\n" });
      sc.settle();
      sc.complete(`lint:p-test-a:${sha("1")}`, { output: lintOk });
      sc.settle();
      sc.complete(`review:p-test-a:${first}`, { report: ok });
      sc.settle();
      assert.equal(sc.state().items["i-test-a"].state, "reviewed");
      // You ask for a new message (or the factory for a bug): the author rewords its commit.
      const plan = resumeAuthorPlan(ID, sc.view(), "i-test-a", "continue", { message: "shorter message" }, "investigating");
      assert.ok(plan && plan !== "busy");
      plan.purpose.key = "author:i-test-a:continue:c-1";
      sc.startJob(plan);
      sc.complete("author:i-test-a:continue:c-1", { report: fixed([sha("2")]) });
      sc.settle();
      const second = sc.view().byKey.get("author:i-test-a:continue:c-1")![0].job;
      sc.complete(`import:${second}`, { output: withCode(sha("2"), code) });
      sc.settle();
      sc.complete(`msg:p-test-a:${sha("2")}`, { output: "Bug 7 - Fix\n" });
      sc.settle();
      sc.complete(`lint:p-test-a:${sha("2")}`, { output: lintOk });
      const next = sc.settle();
      if (code === "P1") {
        assert.deepEqual(next, []);
        assert.equal(sc.state().items["i-test-a"].state, "reviewed");
      } else {
        assert.deepEqual(next, [`review:p-test-a:${second}`]);
      }
    }
  });

  it("critical review findings go back to the author for at most 3 rounds, then come to you", () => {
    const sc = workList([group("ka", "a/test_a.js", "boom")]);
    investigating(sc, "i-test-a");
    let author = "author:i-test-a:initial";
    for (let round = 0; round < 4; round++) {
      const commit = sha(String(round + 1));
      sc.complete(author, { report: fixed([commit]) });
      sc.settle();
      const job = sc.view().byKey.get(author)!.at(-1)!.job;
      sc.complete(`import:${job}`, { output: imported(commit, "Bug 1 - Fix", ["a/test_a.js"], 1) });
      sc.settle();
      sc.complete(`msg:p-test-a:${commit}`, { output: "m" });
      sc.settle();
      sc.complete(`lint:p-test-a:${commit}`, { output: lintOk });
      sc.settle();
      sc.complete(`review:p-test-a:${job}`, { report: { verdict: "findings", findings: [{ severity: "must-fix", file: "a.js", line: 2, text: "guard on the victim's side" }], feedback: [] } });
      const started = sc.settle();
      if (round < 3) {
        author = `author:i-test-a:review:${job}`;
        assert.deepEqual(started, [author]);
        assert.match(sc.plan(author).agent?.message ?? "", /\[must-fix\] a.js:2 guard on the victim's side/);
        assert.equal(sc.state().items["i-test-a"].state, "review findings");
      } else {
        // It goes on into the stack; its findings wait for you on its row.
        assert.ok(!started.some((k) => k.startsWith("author:")));
        assert.equal(sc.state().items["i-test-a"].state, "reviewed");
        assert.equal(sc.state().needsUser[0].action, "No ok after 3 critical review rounds");
      }
    }
    // What accept-review does (commands.ts): it stays reviewed.
    const flag = sc.open()[0];
    sc.add({ type: "item-state", request: ID, item: "i-test-a", state: "reviewed", detail: "accepted by you" });
    sc.add({ type: "user-done", request: ID, key: flag });
    sc.settle();
    assert.equal(sc.state().items["i-test-a"].state, "reviewed");
    assert.deepEqual(sc.open(), []);
  });

  it("a job you stopped stays stopped until a continue or retry reopens its key", () => {
    const sc = workList([group("ka", "a/test_a.js", "boom")]);
    investigating(sc, "i-test-a");
    const commit = sha("1");
    sc.complete("author:i-test-a:initial", { report: fixed([commit]) });
    sc.settle();
    const author = sc.view().byKey.get("author:i-test-a:initial")!.at(-1)!.job;
    sc.complete(`import:${author}`, { output: imported(commit, "Bug 1 - Fix", ["a/test_a.js"], 1) });
    sc.settle();
    sc.complete(`msg:p-test-a:${commit}`, { output: "m" });
    sc.settle();
    const lint = sc.complete(`lint:p-test-a:${commit}`, { exitCode: -1, error: "cancelled by you" });
    assert.deepEqual(sc.settle(), []);
    sc.add({ type: "user-done", request: ID, key: `reopen:${lint}` });
    assert.deepEqual(sc.settle(), [`lint:p-test-a:${commit}`]);
  });

  it("after the review limit, your continue starts a new count of review rounds", () => {
    const sc = workList([group("ka", "a/test_a.js", "boom")]);
    investigating(sc, "i-test-a");
    let author = "author:i-test-a:initial";
    const round = (n: number) => {
      const commit = sha(String(n));
      sc.complete(author, { report: fixed([commit]) });
      sc.settle();
      const job = sc.view().byKey.get(author)!.at(-1)!.job;
      sc.complete(`import:${job}`, { output: imported(commit, "Bug 1 - Fix", ["a/test_a.js"], 1) });
      sc.settle();
      sc.complete(`msg:p-test-a:${commit}`, { output: "m" });
      sc.settle();
      sc.complete(`lint:p-test-a:${commit}`, { output: lintOk });
      sc.settle();
      sc.complete(`review:p-test-a:${job}`, { report: { verdict: "findings", findings: [{ severity: "must-fix", text: "racy" }], feedback: [] } });
      return { job, started: sc.settle() };
    };
    for (let n = 1; n <= 4; n++) {
      const { job } = round(n);
      author = `author:i-test-a:review:${job}`;
    }
    assert.equal(sc.state().items["i-test-a"].state, "reviewed");
    // What continue does (commands.ts): the author resumed with reason "continue".
    const plan = resumeAuthorPlan(ID, sc.view(), "i-test-a", "continue", { message: "keep the wait" }, "investigating");
    assert.ok(plan && plan !== "busy");
    plan.purpose.key = author = "author:i-test-a:continue:c-1";
    sc.startJob(plan);
    const { job, started } = round(5);
    assert.deepEqual(started, [`author:i-test-a:review:${job}`]);
  });

  it("an author that disagrees with your message waits for you, its answer on its job's line", () => {
    const sc = workList([group("ka", "a/test_a.js", "boom")]);
    investigating(sc, "i-test-a");
    sc.complete("author:i-test-a:initial", { report: fixed([sha("1")]) });
    sc.settle();
    const plan = resumeAuthorPlan(ID, sc.view(), "i-test-a", "continue", { message: "fix the leak instead" }, "investigating");
    assert.ok(plan && plan !== "busy");
    plan.purpose.key = "author:i-test-a:continue:c-1";
    sc.startJob(plan);
    sc.complete("author:i-test-a:continue:c-1", { report: fixed([sha("1")], { disagreement: "there is no leak" }) });
    const job = sc.view().byKey.get("author:i-test-a:continue:c-1")![0].job;
    assert.ok(sc.open().includes(`disagrees:${job}`));
    assert.equal(sc.state().jobs[job].outcome, "fix verified locally: disagrees with you: there is no leak", "its answer on its job's line");
    assert.ok(!sc.settle().includes(`import:${job}`), "nothing goes on");
    sc.add({ type: "user-done", request: ID, key: `disagrees:${job}` });
    assert.ok(sc.settle().includes(`import:${job}`), "go ahead with its patch");
  });

  // The author's commit through import and a clean lint; returns the author job.
  function linted(sc: Scenario, author: string, commit: string): string {
    sc.complete(author, { report: fixed([commit]) });
    sc.settle();
    const job = sc.view().byKey.get(author)!.at(-1)!.job;
    sc.complete(`import:${job}`, { output: imported(commit, "Bug 1 - Fix", ["a/test_a.js"], 1) });
    sc.settle();
    sc.complete(`msg:p-test-a:${commit}`, { output: "m" });
    sc.settle();
    sc.complete(`lint:p-test-a:${commit}`, { output: lintOk });
    return job;
  }
  const nit = { severity: "nit", file: "a.js", line: 2, text: "wordy comment" } as const;

  it("a review with must-fix findings sends the nits back with them", () => {
    const sc = workList([group("ka", "a/test_a.js", "boom")]);
    investigating(sc, "i-test-a");
    const job = linted(sc, "author:i-test-a:initial", sha("1"));
    sc.settle();
    sc.complete(`review:p-test-a:${job}`, { report: { verdict: "findings", findings: [{ severity: "must-fix", file: "a.js", line: 5, text: "dead code" }, nit], feedback: [] } });
    assert.deepEqual(sc.settle(), [`author:i-test-a:review:${job}`]);
    const message = sc.plan(`author:i-test-a:review:${job}`).agent?.message ?? "";
    assert.match(message, /\[must-fix\] a.js:5 dead code/);
    assert.match(message, /\[nit\] a.js:2 wordy comment/);
  });

  it("a review with only nits gets one author pass, then only the lint, and the item is reviewed", () => {
    const sc = workList([group("ka", "a/test_a.js", "boom")]);
    investigating(sc, "i-test-a");
    const job = linted(sc, "author:i-test-a:initial", sha("1"));
    sc.settle();
    sc.complete(`review:p-test-a:${job}`, { report: { verdict: "findings", findings: [nit], feedback: [] } });
    assert.equal(sc.of("note").length, 0, "the nits are in the review's report, on its job's line");
    assert.equal(sc.state().jobs[sc.view().byKey.get(`review:p-test-a:${job}`)![0].job].outcome, "findings: 1 nit");
    const nits = `author:i-test-a:nits:${job}`;
    assert.deepEqual(sc.settle(), [nits]);
    assert.match(sc.plan(nits).agent?.message ?? "", /\[nit\] a.js:2 wordy comment[\s\S]*say in one line/);
    assert.match(sc.plan(nits).agent?.message ?? "", /^A critical reviewer/, "no D number before it's submitted");
    assert.equal(sc.state().items["i-test-a"].state, "review findings");
    const second = linted(sc, nits, sha("2"));
    assert.ok(!sc.settle().some((k) => k.startsWith("review:") || k.startsWith("author:")), "no second review");
    assert.ok(!sc.view().byKey.has(`review:p-test-a:${second}`));
    assert.equal(sc.state().items["i-test-a"].state, "reviewed");
    assert.deepEqual(sc.open(), []);
  });

  it("a nits pass that is blocked or fails comes to you", () => {
    for (const blocked of [true, false]) {
      const sc = workList([group("ka", "a/test_a.js", "boom")]);
      investigating(sc, "i-test-a");
      const job = linted(sc, "author:i-test-a:initial", sha("1"));
      sc.settle();
      sc.complete(`review:p-test-a:${job}`, { report: { verdict: "findings", findings: [nit], feedback: [] } });
      const nits = `author:i-test-a:nits:${job}`;
      assert.deepEqual(sc.settle(), [nits]);
      if (blocked) sc.complete(nits, { report: { ...fixed([]), state: "blocked", summary: "can't reword it" } });
      else {
        sc.complete(nits, { error: "invalid report: $.commits: required" });
        sc.settle();
        sc.complete(nits, { error: "invalid report: $.commits: required" });
      }
      assert.deepEqual(sc.settle(), []);
      assert.equal(sc.state().items["i-test-a"].state, "blocked");
      assert.ok(sc.open()[0].startsWith("failed:"));
    }
  });

  const dryOut = { command: ["./mach", "try", "fuzzy"], taskCount: 5, tasks: [], tryTaskConfig: {}, commits: [], warnings: [] };
  // The author asks for a try push; returns its job and the push plan's key.
  // An author you've been talking to: it gets the push it asks for.
  function asking(sc: Scenario): { job: string; planKey: string } {
    sc.complete("author:i-test-a:initial", { report: fixed([], { state: "blocked" }) });
    sc.settle();
    const plan = resumeAuthorPlan(ID, sc.view(), "i-test-a", "continue", { message: "push it on linux" }, "investigating");
    assert.ok(plan && plan !== "busy");
    plan.purpose.key = "author:i-test-a:continue:c-1";
    sc.startJob(plan);
    sc.complete("author:i-test-a:continue:c-1", { report: fixed([sha("1")], { tryRequest: "test_a.js on linux debug, to see the race" }) });
    const job = sc.view().byKey.get("author:i-test-a:continue:c-1")![0].job;
    const planKey = `plan:asked:i-test-a:${job}`;
    assert.deepEqual(sc.settle(), [planKey], "no import, no review: the push first");
    return { job, planKey };
  }

  it("a try push its author asks for is planned in its worktree, approved by you, and its results resume the author before any review", () => {
    const sc = workList([group("ka", "a/test_a.js", "boom")]);
    investigating(sc, "i-test-a");
    const { job, planKey } = asking(sc);
    const plan = sc.plan(planKey);
    assert.equal(plan.name, "plan-try-pushes");
    assert.equal(plan.cwd, `/wt/${ID}-i-test-a`);
    assert.equal(plan.agent?.vars?.branch, `${ID}-i-test-a`);
    assert.equal(plan.agent?.vars?.worktree, `/wt/${ID}-i-test-a`);
    assert.match(String(plan.agent?.vars?.goal), /what the author of a\/test_a.js asked for: test_a.js on linux debug, to see the race/);
    sc.complete(planKey, { report: { pushes: [{ purpose: "p", tryArgs: ["fuzzy", "-q", "x"], rebuild: 5 }], feedback: [] } });
    const push = `test-a-ask-${shortHash([job]).slice(0, 4)}`;
    assert.deepEqual(sc.settle(), [`dry-run:${push}`]);
    sc.complete(`dry-run:${push}`, { output: dryOut });
    sc.settle();
    assert.deepEqual(sc.open().filter((k) => k.startsWith("approve-push:")), [`approve-push:${push}`]);
    assert.equal(sc.state().needsUser.find((n) => n.key === `approve-push:${push}`)?.item, "i-test-a", "its group waits for it");
    sc.add({ type: "user-done", request: ID, key: `approve-push:${push}` });
    assert.deepEqual(sc.settle(), [`push:${push}`]);
    sc.complete(`push:${push}`, { output: { rev: "fed" } });
    sc.add({ type: "try-pushed", request: ID, push, rev: "fed", url: "u" });
    const waiting = sc.settle();
    assert.ok(!waiting.some((k) => k.startsWith("author:") || k.startsWith("review:") || k.startsWith("import:")), String(waiting));
    sc.add({ type: "try-finished", request: ID, push, result: "failures", summary: "2 failures" });
    const resumed = `author:i-test-a:asked:${job}`;
    assert.ok(sc.settle().includes(resumed));
    const r = sc.plan(resumed);
    assert.equal(r.agent?.resume, true);
    assert.equal(r.agent?.sessionId, sc.plan("author:i-test-a:initial").agent?.sessionId);
    assert.match(r.agent?.message ?? "", /^The try push you asked for ran: fed \(2 failures\)\./);
    assert.ok(!sc.view().byKey.has(`import:${job}`), "the asking run's commits are never reviewed");
    // Its next report, without a tryRequest, goes on to import and review.
    sc.complete(resumed, { report: fixed([sha("2")]) });
    const next = sc.view().byKey.get(resumed)![0].job;
    assert.ok(sc.settle().includes(`import:${next}`));
  });

  it("a try push its author asks for on its own isn't made: with commits it goes on to review, without it's told once to add DEBUG commits", () => {
    const sc = workList([group("ka", "a/test_a.js", "boom")]);
    investigating(sc, "i-test-a");
    sc.complete("author:i-test-a:initial", { report: fixed([sha("1")], { tryRequest: "linux debug" }) });
    const job = sc.view().byKey.get("author:i-test-a:initial")![0].job;
    assert.ok(sc.settle().includes(`import:${job}`));
    assert.ok(![...sc.view().byKey.keys()].some((k) => k.startsWith("plan:asked:")));

    const sc2 = workList([group("ka", "a/test_a.js", "boom")]);
    investigating(sc2, "i-test-a");
    sc2.complete("author:i-test-a:initial", { report: fixed([], { state: "blocked", tryRequest: "linux debug" }) });
    const job2 = sc2.view().byKey.get("author:i-test-a:initial")![0].job;
    const told = `author:i-test-a:no-push:${job2}`;
    assert.deepEqual(sc2.settle(), [told]);
    assert.match(sc2.plan(told).agent?.message ?? "", /no try push for one fix[^]*"needs a try repro"/);
    sc2.complete(told, { report: fixed([], { state: "blocked", tryRequest: "linux debug again" }) });
    assert.deepEqual(sc2.settle(), [], "told once");
  });

  it("a try push its author asked for that you decline resumes it with your text; discarding one says nothing", () => {
    for (const text of ["not worth it", "discarded"]) {
      const sc = workList([group("ka", "a/test_a.js", "boom")]);
      investigating(sc, "i-test-a");
      const { job, planKey } = asking(sc);
      sc.complete(planKey, { report: { pushes: [1, 2].map((n) => ({ purpose: `p${n}`, tryArgs: ["fuzzy", "-q", `x${n}`], rebuild: 5 })), feedback: [] } });
      const h = shortHash([job]).slice(0, 4);
      const dries = sc.settle();
      assert.deepEqual(dries, [`dry-run:test-a-ask-${h}-1`, `dry-run:test-a-ask-${h}-2`]);
      for (const d of dries) sc.complete(d, { output: dryOut });
      sc.settle();
      sc.add({ type: "try-declined", request: ID, push: `test-a-ask-${h}-1`, text });
      assert.deepEqual(sc.settle(), []);
      sc.add({ type: "try-declined", request: ID, push: `test-a-ask-${h}-2`, text: "discarded" });
      const resumed = `author:i-test-a:asked:${job}`;
      assert.deepEqual(sc.settle(), [resumed]);
      const message = sc.plan(resumed).agent?.message ?? "";
      if (text === "discarded") assert.match(message, /^The user didn't make the try push you asked for\. Go on without it/);
      else assert.match(message, /^The user didn't make the try push you asked for: “not worth it”\./);
    }
  });

  it("an author that leaves its patch unchanged after a review's findings comes to you instead of another review, once", () => {
    const sc = workList([group("ka", "a/test_a.js", "boom")]);
    investigating(sc, "i-test-a");
    const job = linted(sc, "author:i-test-a:initial", sha("1"));
    sc.settle();
    const review = sc.complete(`review:p-test-a:${job}`, { report: { verdict: "findings", findings: [{ severity: "must-fix", text: "racy" }], feedback: [] } });
    const again = `author:i-test-a:review:${job}`;
    assert.deepEqual(sc.settle(), [again]);
    sc.complete(again, { report: fixed([sha("1")], { summary: "the race can't happen" }) });
    const second = sc.view().byKey.get(again)![0].job;
    sc.settle();
    sc.complete(`import:${second}`, { output: imported(sha("1"), "Bug 1 - Fix", ["a/test_a.js"], 1) });
    assert.deepEqual(sc.settle(), ["wt:root"], "the same commit's lint stands; no new review, on to the stack");
    assert.ok(!sc.view().byKey.has(`review:p-test-a:${second}`));
    assert.deepEqual(sc.open(), [`failed:${review}`]);
    const flag = sc.state().needsUser[0];
    assert.equal(flag.action, "Its author left the patch unchanged after the critical review");
    assert.equal(flag.detail, "the race can't happen");
    assert.equal(flag.item, "i-test-a");
    assert.equal(sc.state().items["i-test-a"].state, "reviewed", "into the stack all the same, the question on its row");
    sc.add({ type: "item-state", request: ID, item: "i-test-a", state: "reviewed", detail: "accepted by you" });
    sc.add({ type: "user-done", request: ID, key: `failed:${review}` });
    assert.deepEqual(sc.settle(), [], "no review");
    assert.deepEqual(sc.open(), [], "not raised again once answered");
    assert.equal(sc.state().items["i-test-a"].state, "reviewed");
  });

  it("an author that leaves it as is ends the item; a blocked one comes to you", () => {
    const sc = workList([group("ka", "a/test_a.js", "boom"), group("kb", "b/test_b.js", "bang")]);
    investigating(sc, "i-test-a");
    investigating(sc, "i-test-b");
    sc.complete("author:i-test-a:initial", { report: { ...fixed([]), state: "left as-is", summary: "fixed on central" } });
    sc.complete("author:i-test-b:initial", { report: { ...fixed([]), state: "blocked", summary: "needs a mac" } });
    // The closed group's worktree goes right away; the blocked one's stays for you.
    assert.deepEqual(sc.settle(), ["remove:r-20261015-test-i-test-a"]);
    assert.deepEqual(sc.plan("remove:r-20261015-test-i-test-a").cli?.args, ["remove", "r-20261015-test-i-test-a"]);
    assert.equal(sc.state().items["i-test-a"].state, "left as-is");
    assert.equal(sc.state().items["i-test-b"].state, "blocked");
    assert.equal(sc.state().needsUser.find((n) => n.item === "i-test-b")?.detail, "needs a mac");
  });
});

describe("a bug an author names", () => {
  it("may be an inactive one closed as INCOMPLETE, which you reopen", () => {
    const sc = workList([group("ka", "a/test_a.js", "boom")]);
    sc.incompleteBugs.add(1800000);
    investigating(sc, "i-test-a");
    sc.complete("author:i-test-a:initial", { report: fixed([sha("1")]) });
    sc.settle();
    const author = sc.view().byKey.get("author:i-test-a:initial")![0].job;
    sc.complete(`import:${author}`, { output: imported(sha("1"), "Bug 1800000 - Fix a/test_a.js, r=smaug.", ["a/test_a.js"], 1800000) });
    sc.settle();
    assert.ok(sc.view().byKey.has(`msg:p-test-a:${sha("1")}`), "checked on as usual");
    assert.equal(sc.state().needsUser.find((n) => n.key === "reopen-bug:1800000")?.action, "Reopen bug 1800000", "for you to reopen");
  });

  it("can't be a FIXED one: it goes back to the author, then to you", () => {
    const sc = workList([group("ka", "a/test_a.js", "boom")]);
    sc.resolvedBugs.add(2026600);
    investigating(sc, "i-test-a");
    sc.complete("author:i-test-a:initial", { report: fixed([sha("1")]) });
    sc.settle();
    const author = sc.view().byKey.get("author:i-test-a:initial")![0].job;
    sc.complete(`import:${author}`, { output: imported(sha("1"), "Bug 2026600 - Fix a/test_a.js, r=smaug.", ["a/test_a.js"], 2026600) });
    sc.settle();
    const told = sc.view().jobs.find((j) => j.purpose.key === `author:i-test-a:bug-resolved:${author}`)!;
    assert.match(sc.plan(told.purpose.key).agent?.message ?? "", /names bug 2026600 \(“bug 2026600”, RESOLVED FIXED\), which is already fixed/);
    assert.ok(!sc.view().jobs.some((j) => j.purpose.key.startsWith("lint:")), "nothing checked further meanwhile");
    // Named again: you decide.
    const again = sc.complete(told.purpose.key, { report: fixed([sha("2")]) });
    sc.settle();
    sc.complete(`import:${again}`, { output: imported(sha("2"), "Bug 2026600 - Fix a/test_a.js, r=smaug.", ["a/test_a.js"], 2026600) });
    sc.settle();
    assert.ok(sc.open().includes("bug-resolved:p-test-a"));
  });
});

describe("failures", () => {
  it("retries a script once, then blocks it and shows you the error", () => {
    const sc = workList([group("ka", "a/test_a.js", "boom")]);
    sc.complete("prior-art:i-test-a", { exitCode: 1, error: "bugzilla is down" });
    assert.deepEqual(sc.step(), ["prior-art:i-test-a"]);
    assert.deepEqual(sc.plan("prior-art:i-test-a").cli?.args, ["prior-art", "a/test_a.js"]);
    const second = sc.complete("prior-art:i-test-a", { exitCode: 1, error: "bugzilla is still down" });
    assert.deepEqual(sc.step(), []);
    const n = sc.state().needsUser[0];
    assert.equal(n.key, `failed:${second}`);
    assert.equal(n.detail, "bugzilla is still down");
    assert.equal(n.job, second);
    assert.equal(sc.state().items["i-test-a"].state, "blocked");
    assert.deepEqual(sc.step(), []);
  });

  it("resumes an agent whose report doesn't match its schema with the errors, once", () => {
    const sc = workList([group("ka", "a/test_a.js", "boom")]);
    investigating(sc, "i-test-a");
    const session = sc.plan("author:i-test-a:initial").agent!.sessionId;
    sc.complete("author:i-test-a:initial", { error: "invalid report: $.commits: required" });
    assert.deepEqual(sc.step(), ["author:i-test-a:initial"]);
    const retry = sc.plan("author:i-test-a:initial");
    assert.equal(retry.agent?.resume, true);
    assert.equal(retry.agent?.sessionId, session);
    assert.match(retry.agent?.message ?? "", /\$\.commits: required/);
    sc.complete("author:i-test-a:initial", { error: "invalid report: $.commits: required" });
    sc.step();
    assert.ok(sc.open()[0].startsWith("failed:"));
  });

  it("does nothing after you cancel a job", () => {
    const sc = workList([group("ka", "a/test_a.js", "boom")]);
    sc.complete("prior-art:i-test-a", { exitCode: 143, error: "cancelled by you" });
    assert.deepEqual(sc.step(), []);
    assert.deepEqual(sc.open(), []);
  });
});

// Two reviewed items in one folder, ready for step 5.
function twoReviewed(reportA?: object): Scenario {
  const sc = workList([group("ka", "a/test_a.js", "boom", 3), group("kb", "a/test_b.js", "bang", 1)]);
  investigating(sc, "i-test-a");
  investigating(sc, "i-test-b");
  reviewed(sc, "i-test-a", sha("1"), "a/test_a.js", reportA ? { report: reportA } : {});
  reviewed(sc, "i-test-b", sha("2"), "a/test_b.js", { title: "Bug 22 - Fix test_b, r=smaug.", bug: 22 });
  return sc;
}

// twoReviewed, assembled, ordered b then a, reviewed and summarized: step 6.
function stacked(reportA?: object): Scenario {
  const sc = twoReviewed(reportA);
  sc.complete("wt:root", { output: { name: `${ID}-root`, path: `/wt/${ID}-root`, branch: `${ID}-root` } });
  sc.settle();
  const key = sc.view().jobs.find((j) => j.purpose.what === "assemble")!.purpose.key;
  sc.complete(key, { output: { branch: `${ID}-root`, commits: [{ sha: sha("1"), newSha: sha("a") }, { sha: sha("2"), newSha: sha("b") }], skipped: [], empty: [] } });
  sc.settle();
  const hash = key.split(":")[2];
  sc.complete(`deps:root:${hash}`, { output: [] });
  sc.complete(`effort:p-test-a:${sha("1")}`, { report: { effort: 2, reason: "r", feedback: [] } });
  sc.complete(`effort:p-test-b:${sha("2")}`, { report: { effort: 1, reason: "r", feedback: [] } });
  sc.settle();
  sc.complete(keyOf(sc, `order:root:${hash}:`), { output: { order: ["p-test-b", "p-test-a"], flippedSoftDeps: [] } });
  sc.settle();
  sc.complete(keyOf(sc, `reorder:root:${hash}:`), { output: { mapping: { [sha("b")]: sha("c"), [sha("a")]: sha("d") } } });
  sc.settle();
  sc.complete(keyOf(sc, `review-stack:root:${hash}:`), { report: { findings: [], addDeps: [], removeDeps: [], feedback: [] } });
  sc.settle();
  sc.complete(`summary:root:${hash}`, { output: { markdown: "| table |", metaComment: "This stack fixes 2 failures." } });
  sc.settle();
  return sc;
}

describe("4b. try repro", () => {
  const open = (sc: Scenario) => sc.view().jobs.filter((j) => !j.end && !j.purpose.key.startsWith("test-plan:")).map((j) => j.purpose.key);
  // Groups a (and c, in a/test_c.js, given DEBUG commits) wait for a try repro with DEBUG commit d (and e); b is
  // reviewed: the stack is built with b's patch alone, up to its verify push's try branch.
  const waitingStack = (two = false) => {
    const groups = [group("ka", "a/test_a.js", "boom"), group("kb", "a/test_b.js", "bang"), ...(two ? [group("kc", "a/test_c.js", "crash")] : [])];
    const sc = workList(groups);
    for (const g of groups) investigating(sc, `i-${g.tests[0].slice(2, -3).replace("_", "-")}`);
    const repro = (item: string, commit: string) => {
      sc.complete(`author:${item}:initial`, { report: fixed([commit], { state: "needs a try repro", summary: "the race only shows on mac debug", profiles: [{ profile: "profile_test_a.js.json.gz", finding: "no marker says which race" }] }) });
      sc.settle();
      assert.equal(sc.state().items[item].state, "waiting for a try repro");
    };
    repro("i-test-a", sha("d"));
    if (two) repro("i-test-c", sha("e"));
    reviewed(sc, "i-test-b", sha("2"), "a/test_b.js");
    assert.deepEqual(open(sc), ["wt:root"], "a group waiting for its repro doesn't hold the stack back");
    sc.complete("wt:root", { output: { name: `${ID}-root`, path: `/wt/${ID}-root`, branch: `${ID}-root` } });
    sc.settle();
    const assemble = keyOf(sc, "assemble:root:");
    assert.deepEqual(sc.plan(assemble).cli?.args.slice(-2), ["--leave-conflict", sha("2")]);
    const hash = assemble.split(":")[2];
    sc.complete(assemble, { output: { branch: `${ID}-root`, commits: [{ sha: sha("2"), newSha: sha("b") }], skipped: [], empty: [] } });
    sc.settle();
    sc.complete(`deps:root:${hash}`, { output: [] });
    sc.complete(`effort:p-test-b:${sha("2")}`, { report: { effort: 1, reason: "r", feedback: [] } });
    sc.settle();
    sc.complete(keyOf(sc, `order:root:${hash}:`), { output: { order: ["p-test-b"], flippedSoftDeps: [] } });
    sc.settle();
    sc.complete(keyOf(sc, `review-stack:root:${hash}:`), { report: { findings: [], addDeps: [], removeDeps: [], feedback: [] } });
    sc.settle();
    sc.complete(`summary:root:${hash}`, { output: { markdown: "t", metaComment: "m" } });
    sc.settle();
    assert.equal(sc.state().step, "verify on try");
    return sc;
  };

  it("refuses a DEBUG push from an author that didn't read the failing jobs' profiles", () => {
    const sc = new Scenario("try-push", { rev: "abc" });
    sc.add({ type: "item-created", request: ID, item: "i-x", folder: "x", group: { message: "m", tests: ["x/test_x.js"], configs: [] } });
    sc.add({ type: "job-started", request: ID, job: "j-a", item: "i-x", kind: "agent", name: "investigate-and-fix", pid: 1, pidStartTime: 1, cmd: [], cwd: "/wt/x", codeVersion: "t", sessionId: "s", purpose: { key: "author:i-x:initial", what: "author", item: "i-x", reason: "initial" } } as never);
    assert.throws(() => sc.complete("author:i-x:initial", { report: fixed([sha("d")], { state: "needs a try repro", summary: "logs only" }) }), (e: Error) => e instanceof InvalidReport && /profiles of the failing tasks first/.test(e.message));
  });

  it("puts a waiting group's DEBUG commits on top of the stack's verify push, then gives its author the results", () => {
    const sc = waitingStack();
    const tb = keyOf(sc, "try-branch:root:");
    assert.match(tb, /^try-branch:root:[0-9a-f]{6}$/);
    assert.deepEqual(sc.plan(tb).cli?.args, ["assemble", "--cwd", `/wt/${ID}-root`, "--branch", `${ID}-root-try-${tb.split(":")[2]}`, "--base", `${ID}-root`, "--leave-conflict", sha("d")]);
    sc.complete(tb, { output: { branch: `${ID}-root-try-${tb.split(":")[2]}`, head: sha("f"), commits: [{ sha: sha("d"), newSha: sha("f") }] } });
    sc.settle();
    const planKey = sc.view().jobs.find((j) => j.purpose.what === "plan-pushes")!.purpose.key;
    assert.equal(sc.plan(planKey).agent?.vars?.branch, `${ID}-root-try-${tb.split(":")[2]}`);
    const failures = JSON.parse(sc.plan(planKey).files![0].content);
    assert.deepEqual(failures.map((f: { patch?: string; toReproduce?: boolean; debugCommits?: string[]; tests: string[] }) => [f.patch, f.toReproduce, f.debugCommits, f.tests]), [
      ["p-test-b", undefined, undefined, ["a/test_b.js"]],
      [undefined, true, [sha("d")], ["a/test_a.js"]],
    ]);
    sc.complete(planKey, { report: { pushes: [{ purpose: "verify", tryArgs: ["fuzzy", "-q", "x"], rebuild: 5 }], feedback: [] } });
    const [dry] = sc.settle();
    const push = sc.purpose(dry).push!;
    sc.complete(dry, { output: { command: ["./mach", "try", "fuzzy"], taskCount: 5, tasks: [], tryTaskConfig: {}, commits: [sha("f"), sha("b")], warnings: [] } });
    sc.add({ type: "user-done", request: ID, key: `approve-push:${push}` });
    sc.add({ type: "try-pushed", request: ID, push, rev: "fed", url: "u" });
    sc.settle();
    assert.ok(!open(sc).some((k) => k.startsWith("author:i-test-a:")), "its author waits for the push's results");
    sc.add({ type: "try-finished", request: ID, push, result: "failures", summary: "3 failures" });
    sc.settle();
    sc.complete(`try-table:${push}:final`, { output: table([{ test: "a/test_a.js", config: "mac", result: "fail", failures: ["boom"], taskIds: ["T1"] }]) });
    sc.settle();
    const resumed = open(sc).filter((k) => k.startsWith("author:i-test-a:"));
    assert.equal(resumed.length, 1);
    assert.match(resumed[0], /^author:i-test-a:repro:[0-9a-f]{8}$/);
    assert.match(sc.plan(resumed[0]).agent?.message ?? "", /^The factory pushed your DEBUG commits to try on top of the stack: fed \(3 failures\)[^]*drop your DEBUG commits/);
    assert.equal(sc.state().items["i-test-a"].state, "investigating");
    // Its test failing is its results: not a failure of the stack's patches, not triaged.
    assert.ok(!open(sc).some((k) => k.startsWith("triage:") || k.startsWith("author:i-test-b:")));
  });

  it("a waiting group's author hears nothing when the stack's push is discarded; your reason when it's declined", () => {
    for (const declined of ["discarded", "not now"]) {
      const sc = waitingStack();
      const tb = keyOf(sc, "try-branch:root:");
      sc.complete(tb, { output: { branch: `${ID}-root-try-${tb.split(":")[2]}`, head: sha("f"), commits: [{ sha: sha("d"), newSha: sha("f") }] } });
      sc.settle();
      const planKey = sc.view().jobs.find((j) => j.purpose.what === "plan-pushes")!.purpose.key;
      sc.complete(planKey, { report: { pushes: [{ purpose: "verify", tryArgs: ["fuzzy", "-q", "x"], rebuild: 5 }], feedback: [] } });
      const [dry] = sc.settle();
      const push = sc.purpose(dry).push!;
      sc.complete(dry, { output: { command: ["./mach", "try", "fuzzy"], taskCount: 5, tasks: [], tryTaskConfig: {}, commits: [sha("f"), sha("b")], warnings: [] } });
      sc.add({ type: "try-declined", request: ID, push, text: declined });
      sc.settle();
      const resumed = open(sc).filter((k) => k.startsWith("author:i-test-a:"));
      if (declined === "discarded") assert.deepEqual(resumed, []);
      else assert.match(sc.plan(resumed[0]).agent?.message ?? "", /^The user declined the stack's try push your DEBUG commits were to go on: “not now”/);
    }
  });

  it("a conflict on the try branch goes to resolve-conflict, then the rest is assembled; an unresolvable one asks you on the group's row and the push waits", () => {
    const conflicted = () => {
      const sc = waitingStack(true);
      const tb = keyOf(sc, "try-branch:root:");
      const h = tb.split(":")[2];
      assert.deepEqual(sc.plan(tb).cli?.args.slice(-3), ["--leave-conflict", sha("d"), sha("e")]);
      sc.complete(tb, { output: { commits: [], conflict: { sha: sha("d"), files: ["a/head.js"] }, remaining: [sha("e")] } });
      const resolve = `resolve:root:try-${h}:${sha("d")}`;
      assert.deepEqual(sc.settle(), [resolve]);
      assert.deepEqual(sc.plan(resolve).agent?.vars, { sha: sha("d"), base: `${ID}-root-try-${h}`, files: "a/head.js" });
      return { sc, h, resolve };
    };
    const plans = (sc: Scenario) => sc.view().jobs.filter((j) => j.purpose.what === "plan-pushes");

    const { sc, h, resolve } = conflicted();
    sc.complete(resolve, { report: { state: "resolved", commit: sha("f"), explanation: "kept both", feedback: [] } });
    const rest = `try-branch:root:${h}:after:${sha("d").slice(0, 12)}`;
    assert.deepEqual(sc.settle(), [rest]);
    assert.deepEqual(sc.plan(rest).cli?.args, ["assemble", "--cwd", `/wt/${ID}-root`, "--branch", `${ID}-root-try-${h}`, "--leave-conflict", sha("e")]);
    sc.complete(rest, { output: { commits: [{ sha: sha("e"), newSha: sha("9") }] } });
    sc.settle();
    const [plan] = plans(sc);
    assert.equal(sc.plan(plan.purpose.key).agent?.vars?.branch, `${ID}-root-try-${h}`);
    const failures = JSON.parse(sc.plan(plan.purpose.key).files![0].content);
    assert.deepEqual(failures.filter((f: { toReproduce?: boolean }) => f.toReproduce).map((f: { tests: string[] }) => f.tests), [["a/test_a.js"], ["a/test_c.js"]]);

    const { sc: sc2, resolve: resolve2 } = conflicted();
    sc2.complete(resolve2, { report: { state: "semantic", explanation: "both rewrite the same setup", feedback: [] } });
    assert.deepEqual(sc2.settle(), []);
    const n = sc2.state().needsUser.find((x) => x.key.startsWith("failed:"))!;
    assert.deepEqual([n.action, n.item, n.detail], ["Its DEBUG commits don't apply on top of the stack", "i-test-a", "both rewrite the same setup"]);
    assert.deepEqual(plans(sc2), [], "the push waits");
  });

  it("a group waiting for a try repro joins a group of its test that has a fix, whose author checks it once its run ends (also when one names the test by file name alone)", () => {
    for (const test of ["a/test_a.js", "test_a.js"]) {
    // z, still investigating, keeps the request from ending.
    const sc = workList([group("ka", "a/test_a.js", "boom"), group("kz", "a/test_z.js", "zap")]);
    investigating(sc, "i-test-a");
    // Out of the way (in the real flow: in the stack), so a later group of its test starts on its own.
    sc.add({ type: "item-state", request: ID, item: "i-test-a", state: "left as-is", detail: "by you" });
    sc.add({ type: "item-created", request: ID, item: "i-test-a-2", folder: "a", group: group("kb", test, "bang") } as never);
    investigating(sc, "i-test-a-2");
    sc.complete("author:i-test-a-2:initial", { report: fixed([sha("d")], { state: "needs a try repro", summary: "mac only", profiles: [{ profile: "none", finding: "the failing tasks have none" }] }) });
    sc.settle();
    assert.equal(sc.state().items["i-test-a-2"].state, "waiting for a try repro");
    sc.complete("author:i-test-a:initial", { report: fixed([sha("1")]) });
    sc.add({ type: "item-state", request: ID, item: "i-test-a", state: "reviewed", detail: "accepted by you" });
    const started = sc.settle();
    assert.equal(sc.state().items["i-test-a-2"].state, "left as-is");
    assert.match(sc.state().items["i-test-a-2"].detail ?? "", /another group of test_a\.js has a fix: its author checks whether it covers this failure/);
    assert.deepEqual(sc.state().items["i-test-a"].group.late, ["bang"]);
    const late = started.find((k) => k.startsWith("author:i-test-a:late:"));
    assert.match(late ?? String(started), /^author:i-test-a:late:[0-9a-f]{8}$/);
    assert.match(sc.plan(late!).agent?.message ?? "", /also failed with: "bang"/);
    }
  });
});

describe("4. author reports", () => {
  it("a reported commit its worktree doesn't have (a sha half made up) is an invalid report", () => {
    const sc = workList([group("ka", "a/test_a.js", "boom")]);
    investigating(sc, "i-test-a");
    const real = sha("1");
    sc.commitExists = (_cwd, c) => c === real;
    const bad = sha("1").slice(0, 12) + "0".repeat(28);
    const report = { state: "fix verified locally", summary: "s", cause: "c", verification: "v", commits: [bad], landsAfter: [], feedback: [] };
    const key = sc.view().jobs.find((j) => !j.end && j.purpose.what === "author")!.purpose.key;
    assert.throws(() => sc.complete(key, { report }), (e: Error) => e instanceof InvalidReport && e.message.startsWith(`${bad} isn't a commit in `));
  });
});

describe("5. stack", () => {
  it("assembles a settled folder, finds deps and efforts, orders, reviews the stack and summarizes it", () => {
    const sc = twoReviewed();
    assert.equal(sc.state().step, "stack");
    assert.deepEqual(sc.view().jobs.filter((j) => !j.end && !j.purpose.key.startsWith("test-plan:")).map((j) => j.purpose.key), ["wt:root"]);
    sc.complete("wt:root", { output: { name: `${ID}-root`, path: `/wt/${ID}-root`, branch: `${ID}-root` } });
    const [assemble] = sc.settle();
    assert.match(assemble, /^assemble:root:[0-9a-f]{10}$/);
    assert.deepEqual(sc.plan(assemble).cli?.args, ["assemble", "--cwd", `/wt/${ID}-root`, "--branch", `${ID}-root`, "--base", "origin/main", "--leave-conflict", sha("1"), sha("2")]);
    sc.complete(assemble, { output: { branch: `${ID}-root`, commits: [{ sha: sha("1"), newSha: sha("a") }, { sha: sha("2"), newSha: sha("b") }], skipped: [], empty: [] } });
    assert.equal(sc.state().patches["p-test-a"].sha, sha("a"));
    assert.equal(sc.state().patches["p-test-a"].worktree, `/wt/${ID}-root`);
    const hash = assemble.split(":")[2];
    assert.deepEqual(sc.settle().sort(), [`deps:root:${hash}`, `effort:p-test-a:${sha("1")}`, `effort:p-test-b:${sha("2")}`]);
    sc.complete(`deps:root:${hash}`, { output: [{ patch: sha("a"), needs: sha("b"), kind: "hard", reason: "textual", source: "textual" }] });
    assert.deepEqual(sc.state().patches["p-test-a"].deps.map((d) => d.needs), ["p-test-b"]);
    sc.complete(`effort:p-test-a:${sha("1")}`, { report: { effort: 2, reason: "r", feedback: [] } });
    sc.complete(`effort:p-test-b:${sha("2")}`, { report: { effort: 1, reason: "r", feedback: [] } });
    const [ord] = sc.settle();
    assert.match(ord, new RegExp(`^order:root:${hash}:[0-9a-f]{6}$`));
    const input = JSON.parse(sc.plan(ord).files![0].content);
    assert.deepEqual(input.patches, [{ id: "p-test-a", effort: 2, value: 3, testOnly: true, accepted: false, commentsAddressed: true }, { id: "p-test-b", effort: 1, value: 1, testOnly: true, accepted: false, commentsAddressed: true }]);
    sc.complete(ord, { output: { order: ["p-test-b", "p-test-a"], flippedSoftDeps: [] } });
    assert.deepEqual(sc.settle(), [`re${ord}`]);
    assert.deepEqual(sc.plan(`re${ord}`).cli?.args.slice(-2), ["--order", `${sha("b")},${sha("a")}`]);
    sc.complete(`re${ord}`, { output: { mapping: { [sha("b")]: sha("c"), [sha("a")]: sha("d") } } });
    assert.deepEqual(sc.settle(), [keyOf(sc, `review-stack:root:${hash}:`)]);
    assert.deepEqual(sc.state().stacks.root.order, ["p-test-b", "p-test-a"]);
    assert.equal(sc.state().patches["p-test-b"].sha, sha("c"));
    sc.complete(keyOf(sc, `review-stack:root:${hash}:`), { report: { findings: [{ patch: sha("c"), severity: "nit", text: "typo" }], addDeps: [], removeDeps: [], feedback: [] } });
    assert.deepEqual(sc.settle(), [`summary:root:${hash}`]);
    sc.complete(`summary:root:${hash}`, { output: { markdown: "| table |", metaComment: "This stack fixes 2 failures." } });
    sc.settle();
    const s = sc.state();
    assert.equal(s.stacks.root.summary, "This stack fixes 2 failures.");
    assert.equal(s.items["i-test-a"].state, "in stack");
    assert.equal(s.step, "verify on try");
  });

  it("assembles a stack again when it comes back to patches it had before: its branch was rewritten since", () => {
    const sc = twoReviewed();
    sc.complete("wt:root", { output: { name: `${ID}-root`, path: `/wt/${ID}-root`, branch: `${ID}-root` } });
    const [both] = sc.settle();
    sc.complete(both, { output: { branch: `${ID}-root`, commits: [{ sha: sha("1"), newSha: sha("a") }, { sha: sha("2"), newSha: sha("b") }], skipped: [], empty: [] } });
    sc.add({ type: "item-state", request: ID, item: "i-test-b", state: "taken over" });
    const alone = sc.settle().find((k) => k.startsWith("assemble:root:"))!;
    assert.notEqual(alone, both);
    sc.complete(alone, { output: { mapping: { [sha("a")]: sha("c") } } });
    sc.add({ type: "item-state", request: ID, item: "i-test-b", state: "reviewed" });
    const again = sc.settle().find((k) => k.startsWith("assemble:root:"));
    assert.equal(again, `${both}-2`);
  });

  it("names a stack after its folder, cutting its first parts to one letter so the last ones fit", () => {
    assert.equal(stackId("dom/base/test"), "dom-base-test");
    assert.equal(stackId("browser/components/enterprisepolicies/tests/browser"), "b-c-enterprisepolicies-tests-browser");
    assert.equal(stackId("browser/components/enterprisepolicies/tests/xpcshell"), "b-c-enterprisepolicies-tests-xpcshell");
    assert.equal(stackId(""), "root");
  });

  it("gives a try-push request's two folders, even ones whose names start alike, one stack", () => {
    const long = "a".repeat(45);
    const sc = workList([group("ka", `${long}/x/test_a.js`, "boom"), group("kb", `${long}/y/test_b.js`, "bang")]);
    investigating(sc, "i-test-a");
    investigating(sc, "i-test-b");
    reviewed(sc, "i-test-a", sha("1"), `${long}/x/test_a.js`);
    reviewed(sc, "i-test-b", sha("2"), `${long}/y/test_b.js`);
    const wts = sc.view().jobs.filter((j) => j.purpose.key.startsWith("wt:") && !j.purpose.key.startsWith("wt:i-")).map((j) => j.purpose.key);
    assert.deepEqual(wts, ["wt:root"]);
  });

  it("puts a try-push request's patches of two folders in one stack; a stack made per folder before, without a revision, is gone", () => {
    const sc = workList([group("ka", "a/test_a.js", "boom"), group("kb", "b/test_b.js", "bang")]);
    sc.add({ type: "stack", request: ID, stack: "a", folder: "a", branch: `${ID}-a`, worktree: `/wt/${ID}-a`, order: ["p-test-a"] });
    investigating(sc, "i-test-a");
    investigating(sc, "i-test-b");
    reviewed(sc, "i-test-a", sha("1"), "a/test_a.js");
    reviewed(sc, "i-test-b", sha("2"), "b/test_b.js");
    sc.complete("wt:root", { output: { name: `${ID}-root`, path: `/wt/${ID}-root`, branch: `${ID}-root` } });
    const [assemble] = sc.settle();
    assert.match(assemble, /^assemble:root:/);
    assert.deepEqual(sc.plan(assemble).cli?.args.slice(-2), [sha("1"), sha("2")]);
    sc.complete(assemble, { output: { branch: `${ID}-root`, commits: [{ sha: sha("1"), newSha: sha("a") }, { sha: sha("2"), newSha: sha("b") }], skipped: [], empty: [] } });
    sc.settle();
    const hash = assemble.split(":")[2];
    sc.complete(`deps:root:${hash}`, { output: [] });
    sc.complete(`effort:p-test-a:${sha("1")}`, { report: { effort: 2, reason: "r", feedback: [] } });
    sc.complete(`effort:p-test-b:${sha("2")}`, { report: { effort: 1, reason: "r", feedback: [] } });
    sc.settle();
    sc.complete(keyOf(sc, `order:root:${hash}:`), { output: { order: ["p-test-a", "p-test-b"], flippedSoftDeps: [] } });
    sc.settle();
    sc.complete(keyOf(sc, `review-stack:root:${hash}:`), { report: { findings: [], addDeps: [], removeDeps: [], feedback: [] } });
    sc.settle();
    sc.complete(`summary:root:${hash}`, { output: { markdown: "| table |", metaComment: "This stack fixes 2 failures." } });
    sc.settle();
    const s = sc.state();
    assert.equal(s.step, "verify on try");
    assert.deepEqual(s.stacks.root.order, ["p-test-a", "p-test-b"]);
    assert.deepEqual(Object.keys(s.stacks), ["root"], "the per-folder stack is dropped");
    const planKey = sc.view().jobs.find((j) => j.purpose.what === "plan-pushes")!.purpose.key;
    sc.complete(planKey, { report: { pushes: [{ purpose: "verify", tryArgs: ["fuzzy", "-q", "x"], rebuild: 5 }], feedback: [] } });
    const [dry] = sc.settle();
    const push = sc.purpose(dry).push!;
    sc.complete(dry, { output: { command: ["./mach", "try", "fuzzy"], taskCount: 5, tasks: [], tryTaskConfig: {}, commits: [], warnings: [] } });
    sc.add({ type: "user-done", request: ID, key: `approve-push:${push}` });
    sc.add({ type: "try-pushed", request: ID, push, rev: "fed", url: "u" });
    sc.add({ type: "try-finished", request: ID, push, result: "green", summary: "green" });
    sc.settle();
    sc.complete(`try-table:${push}:final`, { output: table() });
    sc.settle();
    assert.deepEqual(sc.open().sort(), ["file-bug:p-test-a:meta-bug-step", "file-bug:p-test-b:meta-bug-step"], "nothing for the per-folder stack");
    const keys = sc.view().jobs.map((j) => j.purpose.key);
    assert.ok(!keys.some((k) => /^[a-z-]+:a(:|$)/.test(k)), JSON.stringify(keys));
    assert.ok(!sc.state().needsUser.some((n) => n.stack === "a"));
  });

  it("orders by an author's lands-after that names another patch by an earlier sha, or by its title", () => {
    for (const what of [`${sha("2").slice(0, 12)} (stack: 1d1e0248d718) the other fix`, "Fix test_b"]) {
      const sc = twoReviewed({ landsAfter: [{ what, reason: "fails without it" }] });
      sc.complete("wt:root", { output: { name: `${ID}-root`, path: `/wt/${ID}-root`, branch: `${ID}-root` } });
      sc.settle();
      const key = sc.view().jobs.find((j) => j.purpose.what === "assemble")!.purpose.key;
      sc.complete(key, { output: { branch: `${ID}-root`, commits: [{ sha: sha("1"), newSha: sha("a") }, { sha: sha("2"), newSha: sha("b") }], skipped: [], empty: [] } });
      sc.settle();
      const hash = key.split(":")[2];
      sc.complete(`deps:root:${hash}`, { output: [] });
      sc.complete(`effort:p-test-a:${sha("1")}`, { report: { effort: 2, reason: "r", feedback: [] } });
      sc.complete(`effort:p-test-b:${sha("2")}`, { report: { effort: 1, reason: "r", feedback: [] } });
      sc.settle();
      const input = JSON.parse(sc.plan(keyOf(sc, `order:root:${hash}:`)).files![0].content);
      assert.deepEqual(input.deps.map((d: { patch: string; needs: string; kind: string }) => [d.patch, d.needs, d.kind]), [["p-test-a", "p-test-b", "hard"]], what);
    }
  });

  it("goes on when an author reported its commit by a short sha (12 or 7 characters)", () => {
    for (const length of [12, 7]) {
      const sc = workList([group("ka", "a/test_a.js", "boom")]);
      investigating(sc, "i-test-a");
      reviewed(sc, "i-test-a", sha("1").slice(0, length), "a/test_a.js");
      sc.complete("wt:root", { output: { name: `${ID}-root`, path: `/wt/${ID}-root`, branch: `${ID}-root` } });
      const [assemble] = sc.settle();
      sc.complete(assemble, { output: { branch: `${ID}-root`, commits: [{ sha: sha("1"), newSha: sha("a") }], skipped: [], empty: [] } });
      assert.equal(sc.state().patches["p-test-a"].worktree, `/wt/${ID}-root`, `${length} characters`);
      assert.ok(sc.settle().includes(`deps:root:${assemble.split(":")[2]}`));
    }
  });

  it("drops the ⚑ of a job of an earlier version of the stack", () => {
    const sc = twoReviewed();
    sc.startJob({ purpose: { key: "review-stack:root:0123456789", what: "review-stack", stack: "root" }, kind: "agent", name: "review-stack", cwd: "/wt", agent: { sessionId: "s-old", resume: false, message: "x" } });
    const old = sc.running("review-stack:root:0123456789");
    sc.complete("review-stack:root:0123456789", { exitCode: -1, error: "cancelled by you" });
    sc.add({ type: "needs-user", request: ID, key: `stopped:${old}`, action: "stopped", detail: "", job: old });
    sc.settle();
    assert.ok(!sc.open().includes(`stopped:${old}`));
  });

  it("waits for every item of the folder", () => {
    const sc = workList([group("ka", "a/test_a.js", "boom"), group("kb", "a/test_b.js", "bang")]);
    investigating(sc, "i-test-a");
    investigating(sc, "i-test-b");
    reviewed(sc, "i-test-a", sha("1"), "a/test_a.js");
    assert.ok(!sc.view().byKey.has("wt:root"));
  });

  it("sends a stack review's must-fix finding to that patch's author", () => {
    const sc = twoReviewed();
    sc.complete("wt:root", { output: { path: `/wt/${ID}-root` } });
    sc.settle();
    const key = sc.view().jobs.find((j) => j.purpose.what === "assemble")!.purpose.key;
    const hash = key.split(":")[2];
    sc.complete(key, { output: { commits: [{ sha: sha("1"), newSha: sha("a") }, { sha: sha("2"), newSha: sha("b") }] } });
    sc.settle();
    sc.complete(`deps:root:${hash}`, { output: [] });
    sc.complete(`effort:p-test-a:${sha("1")}`, { report: { effort: 2, reason: "r", feedback: [] } });
    sc.complete(`effort:p-test-b:${sha("2")}`, { report: { effort: 1, reason: "r", feedback: [] } });
    sc.settle();
    sc.complete(keyOf(sc, `order:root:${hash}:`), { output: { order: ["p-test-a", "p-test-b"], flippedSoftDeps: [] } });
    assert.deepEqual(sc.settle(), [keyOf(sc, `review-stack:root:${hash}:`)]);
    const review = sc.complete(keyOf(sc, `review-stack:root:${hash}:`), { report: { findings: [{ patch: sha("b"), severity: "must-fix", text: "same approach as test_a" }], addDeps: [], removeDeps: [], feedback: [] } });
    assert.deepEqual(sc.settle(), [`author:i-test-b:stack-review:${review}`]);
    assert.match(sc.plan(`author:i-test-b:stack-review:${review}`).agent?.message ?? "", /same approach as test_a[^]*drop your commits and report "left as-is"/);
    assert.equal(sc.state().items["i-test-b"].state, "investigating");
  });

  it("a patch the stack review keeps flagging after rounds with its author comes to you on its group's row; the others' authors are still told", () => {
    const sc = twoReviewed();
    sc.complete("wt:root", { output: { path: `/wt/${ID}-root` } });
    sc.settle();
    const key = sc.view().jobs.find((j) => j.purpose.what === "assemble")!.purpose.key;
    const hash = key.split(":")[2];
    sc.complete(key, { output: { commits: [{ sha: sha("1"), newSha: sha("a") }, { sha: sha("2"), newSha: sha("b") }] } });
    sc.settle();
    sc.complete(`deps:root:${hash}`, { output: [] });
    sc.complete(`effort:p-test-a:${sha("1")}`, { report: { effort: 2, reason: "r", feedback: [] } });
    sc.complete(`effort:p-test-b:${sha("2")}`, { report: { effort: 1, reason: "r", feedback: [] } });
    sc.settle();
    sc.complete(keyOf(sc, `order:root:${hash}:`), { output: { order: ["p-test-a", "p-test-b"], flippedSoftDeps: [] } });
    sc.settle();
    // Its author already answered three stack reviews (other reviews of the stack don't count).
    for (const n of [1, 2, 3]) {
      sc.add({ type: "job-started", request: ID, job: `j-sr${n}`, item: "i-test-b", kind: "agent", name: "investigate-and-fix", pid: 1, pidStartTime: 1, cmd: [], cwd: "/wt", codeVersion: "t", sessionId: "s", purpose: { key: `author:i-test-b:stack-review:j-r${n}`, what: "author", item: "i-test-b", reason: "stack review" } } as never);
      sc.reports.set(`j-sr${n}`, fixed([sha("2")]));
      sc.add({ type: "job-finished", request: ID, job: `j-sr${n}`, exitCode: 0, durationMs: 1 });
    }
    const review = sc.complete(keyOf(sc, `review-stack:root:${hash}:`), {
      report: { findings: [{ patch: sha("b"), severity: "must-fix", text: "duplicates test_a's fix" }, { patch: sha("a"), severity: "must-fix", text: "typo in the message" }], addDeps: [], removeDeps: [], feedback: [] },
    });
    assert.deepEqual(sc.settle().filter((k) => k.startsWith("author:")), [`author:i-test-a:stack-review:${review}`]);
    const flag = sc.state().needsUser.find((n) => n.key === `stack-review:i-test-b:${review}`);
    assert.equal(flag?.item, "i-test-b");
    assert.match(flag?.detail ?? "", /duplicates test_a's fix/);
  });

  it("a patch whose commit comes out empty in the stack goes back to its author, told another commit covers it", () => {
    const sc = twoReviewed();
    sc.complete("wt:root", { output: { path: `/wt/${ID}-root` } });
    sc.settle();
    const key = sc.view().jobs.find((j) => j.purpose.what === "assemble")!.purpose.key;
    sc.complete(key, { output: { commits: [{ sha: sha("1"), newSha: sha("a") }], empty: [sha("2")] } });
    const started = sc.settle();
    const told = started.find((k) => k.startsWith("author:i-test-b:empty:"))!;
    assert.ok(told, String(started));
    assert.match(sc.plan(told).agent?.message ?? "", /made no change[^]*report "left as-is", with that commit's sha in `coveredBy`/);
    assert.equal(sc.state().items["i-test-b"].state, "investigating");
    // Its answer names the covering patch, which then fixes its tests too.
    sc.complete(told, { report: { ...fixed([]), state: "left as-is", summary: "covered by test_a's fix", coveredBy: sha("a").slice(0, 12) } });
    assert.equal(sc.state().items["i-test-b"].coveredBy, "p-test-a");
  });

  it("hands a text conflict to resolve-conflict, then assembles the rest", () => {
    const sc = twoReviewed();
    sc.complete("wt:root", { output: { path: `/wt/${ID}-root` } });
    sc.settle();
    const key = sc.view().jobs.find((j) => j.purpose.what === "assemble")!.purpose.key;
    const hash = key.split(":")[2];
    sc.complete(key, { output: { commits: [], conflict: { sha: sha("1"), files: ["a/test_a.js"] }, remaining: [sha("2")] } });
    assert.deepEqual(sc.settle(), [`resolve:root:${hash}:${sha("1")}`]);
    assert.deepEqual(sc.plan(`resolve:root:${hash}:${sha("1")}`).agent?.vars, { sha: sha("1"), base: `${ID}-root`, files: "a/test_a.js" });
    sc.complete(`resolve:root:${hash}:${sha("1")}`, { report: { state: "resolved", commit: sha("a"), explanation: "kept both", feedback: [] } });
    assert.equal(sc.state().patches["p-test-a"].sha, sha("a"));
    const rest = `assemble:root:${hash}:after:${sha("1").slice(0, 12)}`;
    assert.deepEqual(sc.settle(), [rest]);
    assert.deepEqual(sc.plan(rest).cli?.args, ["assemble", "--cwd", `/wt/${ID}-root`, "--branch", `${ID}-root`, "--leave-conflict", sha("2")]);
    sc.complete(rest, { output: { commits: [{ sha: sha("2"), newSha: sha("b") }] } });
    assert.ok(sc.settle().includes(`deps:root:${hash}`));
  });
  it("a patch whose fix is already there (an earlier stack patch, or the base): its author keeps only what isn't covered", () => {
    const sc = twoReviewed();
    sc.complete("wt:root", { output: { path: `/wt/${ID}-root` } });
    sc.settle();
    const key = sc.view().jobs.find((j) => j.purpose.what === "assemble")!.purpose.key;
    const hash = key.split(":")[2];
    sc.complete(key, { output: { commits: [], conflict: { sha: sha("1"), files: ["a/test_a.js"] }, remaining: [sha("2")] } });
    sc.settle();
    sc.complete(`resolve:root:${hash}:${sha("1")}`, { report: { state: "already fixed", explanation: "stack patch 5bda7bf makes the same change", feedback: [] } });
    const resolve = sc.view().byKey.get(`resolve:root:${hash}:${sha("1")}`)![0].job;
    assert.deepEqual(sc.settle(), [`abort:${resolve}:v2`], "the cherry-pick left in progress goes first");
    assert.deepEqual(sc.plan(`abort:${resolve}:v2`).cli, { tool: "sh", args: ["-c", 'test ! -e "$(git rev-parse --git-path CHERRY_PICK_HEAD)" || git cherry-pick --abort'] });
    sc.complete(`abort:${resolve}:v2`, { output: "" });
    const covered = `author:i-test-a:covered:${resolve}`;
    assert.deepEqual(sc.settle(), [covered]);
    assert.match(sc.plan(covered).agent?.message ?? "", /stack patch 5bda7bf makes the same change[^]*keep only what it doesn't already do[^]*"left as-is"/);
    assert.deepEqual(sc.state().needsUser, []);
  });

  it("a conflict on a patch whose author reported a short sha goes to resolve-conflict too", () => {
    const sc = workList([group("ka", "a/test_a.js", "boom", 3), group("kb", "a/test_b.js", "bang", 1)]);
    investigating(sc, "i-test-a");
    investigating(sc, "i-test-b");
    reviewed(sc, "i-test-a", sha("1").slice(0, 12), "a/test_a.js");
    reviewed(sc, "i-test-b", sha("2"), "a/test_b.js", { title: "Bug 22 - Fix test_b, r=smaug.", bug: 22 });
    sc.complete("wt:root", { output: { path: `/wt/${ID}-root` } });
    sc.settle();
    const key = sc.view().jobs.find((j) => j.purpose.what === "assemble")!.purpose.key;
    const hash = key.split(":")[2];
    sc.complete(key, { output: { commits: [], conflict: { sha: sha("1"), files: ["a/test_a.js"] }, remaining: [sha("2")] } });
    assert.deepEqual(sc.settle(), [`resolve:root:${hash}:${sha("1")}`]);
    assert.deepEqual(sc.purpose(`resolve:root:${hash}:${sha("1")}`).patches, { [sha("1").slice(0, 12)]: "p-test-a" });
  });
});

describe("6. verify on try", () => {
  it("a failure you leave as a follow-up doesn't go to its author", () => {
    const sc = stacked();
    const planKey = sc.view().jobs.find((j) => j.purpose.what === "plan-pushes")!.purpose.key;
    sc.complete(planKey, { report: { pushes: [{ purpose: "verify", tryArgs: ["fuzzy", "-q", "x"], rebuild: 5 }], feedback: [] } });
    const [dry] = sc.settle();
    const push = sc.purpose(dry).push!;
    sc.complete(dry, { output: { command: ["./mach", "try", "fuzzy", "-q", "x"], taskCount: 5, tasks: [], tryTaskConfig: {}, commits: [], warnings: [] } });
    sc.add({ type: "user-done", request: ID, key: `approve-push:${push}` });
    sc.settle();
    sc.complete(`push:${push}`, { output: { rev: "fed", landoJobId: 1, treeherderUrl: "t" } });
    sc.settle();
    sc.add({ type: "try-finished", request: ID, push, result: "failures", summary: "s" });
    sc.settle();
    command(sc, { cmd: "follow-up", push, patch: "p-test-a" });
    sc.complete(`try-table:${push}:final`, { output: table([{ test: "a/test_a.js", config: "linux", result: "fail", failures: ["slow in chaos mode"], taskIds: ["T1"] }]) });
    assert.ok(!sc.settle().some((k) => k.startsWith("author:i-test-a:try:")));
  });

  it("plans the pushes, then routes matched failures to their author and the rest to triage", () => {
    const sc = stacked();
    assert.equal(sc.state().step, "verify on try");
    const planKey = sc.view().jobs.find((j) => j.purpose.what === "plan-pushes")!.purpose.key;
    const vars = sc.plan(planKey).agent!.vars!;
    assert.equal(vars.branch, `${ID}-root`);
    const failures = JSON.parse(sc.plan(planKey).files![0].content);
    assert.deepEqual(failures.map((f: { patch: string }) => f.patch), ["p-test-a", "p-test-b"]);
    sc.complete(planKey, { report: { pushes: [{ purpose: "verify", tryArgs: ["fuzzy", "-q", "x"], rebuild: 5 }], feedback: [] } });
    const [dry] = sc.settle();
    const push = sc.purpose(dry).push!;
    sc.complete(dry, { output: { command: ["./mach", "try", "fuzzy", "-q", "x"], taskCount: 5, tasks: [], tryTaskConfig: {}, commits: [], warnings: [] } });
    sc.add({ type: "user-done", request: ID, key: `approve-push:${push}` });
    assert.deepEqual(sc.settle(), [`push:${push}`]);
    sc.complete(`push:${push}`, { output: { rev: "fed", landoJobId: 1, treeherderUrl: "t" } });
    assert.equal(sc.state().items["i-test-a"].state, "in try");
    assert.deepEqual(sc.settle(), [`watch:${push}`]);
    sc.add({ type: "try-finished", request: ID, push, result: "failures", summary: "s" });
    sc.settle();
    sc.complete(`try-table:${push}:final`, {
      output: table([
        { test: "a/test_a.js", config: "linux", result: "fail", failures: ["still boom"], taskIds: ["T1"] },
        { test: "z/test_z.js", config: "linux", result: "fail", failures: ["zap"], taskIds: ["T2"] },
      ]),
    });
    const started = sc.settle();
    assert.deepEqual(started.sort(), [`author:i-test-a:try:${push}`, `triage:${push}:final:v2`].sort());
    assert.match(sc.plan(`author:i-test-a:try:${push}`).agent?.message ?? "", /a\/test_a.js on linux: still boom/);
    const input = JSON.parse(sc.plan(`triage:${push}:final:v2`).files![0].content);
    // The push's patches and their files, so triage can tell a failure one of them caused.
    assert.deepEqual(input.patches, [
      { id: "p-test-b", sha: sha("c"), title: "Bug 22 - Fix test_b, r=smaug.", files: ["a/test_b.js"] },
      { id: "p-test-a", sha: sha("d"), title: "Bug XXXXXXX - Fix a/test_a.js, r=smaug.", files: ["a/test_a.js"] },
    ]);
    assert.deepEqual([input.rev, input.rows.map((r: { test: string }) => r.test), input.unparsed], ["fed", ["z/test_z.js"], []]);
    sc.complete(`triage:${push}:final:v2`, { report: { cells: [{ test: "z/test_z.js", verdict: "broken by patch", patch: sha("c"), evidence: "TypeError" }], feedback: [] } });
    assert.deepEqual(sc.settle(), [`author:i-test-b:try:${push}`]);
    assert.equal(sc.state().step, "verify on try");
  });

  it("a push whose only failures are pre-existing or infra passes, and the request moves on", () => {
    const sc = stacked();
    const planKey = sc.view().jobs.find((j) => j.purpose.what === "plan-pushes")!.purpose.key;
    sc.complete(planKey, { report: { pushes: [{ purpose: "verify", tryArgs: ["fuzzy", "-q", "x"], rebuild: 5 }], feedback: [] } });
    const [dry] = sc.settle();
    const push = sc.purpose(dry).push!;
    sc.complete(dry, { output: { command: ["./mach", "try", "fuzzy", "-q", "x"], taskCount: 5, tasks: [], tryTaskConfig: {}, commits: [], warnings: [] } });
    sc.add({ type: "user-done", request: ID, key: `approve-push:${push}` });
    sc.settle();
    sc.complete(`push:${push}`, { output: { rev: "fed", landoJobId: 1, treeherderUrl: "t" } });
    sc.settle();
    sc.add({ type: "try-finished", request: ID, push, result: "failures", summary: "s" });
    sc.settle();
    sc.complete(`try-table:${push}:final`, { output: table([{ test: "z/test_z.js", config: "linux", result: "fail", failures: ["zap"], taskIds: ["T2"] }]) });
    sc.settle();
    assert.equal(sc.state().step, "verify on try", "not before its triage");
    sc.complete(`triage:${push}:final:v2`, { report: { cells: [{ test: "z/test_z.js", config: "linux", verdict: "pre-existing", evidence: "fails on central too" }], feedback: [] } });
    sc.settle();
    assert.equal(sc.state().step, "meta bug");
  });

  it("a failure already on central becomes a group when you ask to fix it too, and the request goes back to fixing", () => {
    const sc = stacked();
    const planKey = sc.view().jobs.find((j) => j.purpose.what === "plan-pushes")!.purpose.key;
    sc.complete(planKey, { report: { pushes: [{ purpose: "verify", tryArgs: ["fuzzy", "-q", "x"], rebuild: 5 }], feedback: [] } });
    const [dry] = sc.settle();
    const push = sc.purpose(dry).push!;
    sc.complete(dry, { output: { command: ["./mach", "try", "fuzzy", "-q", "x"], taskCount: 5, tasks: [], tryTaskConfig: {}, commits: [], warnings: [] } });
    sc.add({ type: "user-done", request: ID, key: `approve-push:${push}` });
    sc.settle();
    sc.complete(`push:${push}`, { output: { rev: "fed", landoJobId: 1, treeherderUrl: "t" } });
    sc.settle();
    // You moved on (submitted) while it ran: its failures are still triaged.
    sc.add({ type: "step", request: ID, step: "review comments" });
    sc.add({ type: "try-finished", request: ID, push, result: "failures", summary: "s" });
    sc.settle();
    sc.complete(`try-table:${push}:final`, { output: table([{ test: "z/test_z.js", config: "linux", result: "fail", failures: ["zap"], taskIds: ["T2"] }]) });
    sc.settle();
    sc.complete(`triage:${push}:final:v2`, { report: { cells: [{ test: "z/test_z.js", config: "linux", verdict: "pre-existing", evidence: "fails on central too" }], feedback: [] } });
    sc.settle();
    assert.ok(!Object.values(sc.state().items).some((i) => i.group.tests.includes("z/test_z.js")), "only noted");
    sc.add({ type: "tests-asked", request: ID, tests: ["z/test_z.js"] });
    sc.settle();
    const item = Object.values(sc.state().items).find((i) => i.group.tests.includes("z/test_z.js"));
    assert.equal(item?.group.message, "fails on central too");
    assert.equal(sc.state().step, "investigate and fix");
  });

  it("moves to the meta bug once every push is green", () => {
    const sc = stacked();
    const planKey = sc.view().jobs.find((j) => j.purpose.what === "plan-pushes")!.purpose.key;
    sc.complete(planKey, { report: { pushes: [{ purpose: "verify", tryArgs: ["fuzzy", "-q", "x"], rebuild: 5 }], feedback: [] } });
    const [dry] = sc.settle();
    const push = sc.purpose(dry).push!;
    sc.complete(dry, { output: { command: ["./mach", "try", "fuzzy"], taskCount: 5, tasks: [], tryTaskConfig: {}, commits: [], warnings: [] } });
    sc.add({ type: "user-done", request: ID, key: `approve-push:${push}` });
    sc.add({ type: "try-pushed", request: ID, push, rev: "fed", url: "u" });
    sc.add({ type: "try-finished", request: ID, push, result: "green", summary: "green" });
    sc.settle();
    sc.complete(`try-table:${push}:final`, { output: table() });
    sc.settle();
    assert.equal(sc.state().step, "meta bug");
  });
});

// A verify push whose early run told i-test-a about a/test_a.js on linux; the push then finishes with these rows.
function earlyThenFinal(finalRows: unknown[]): { sc: Scenario; push: string } {
  const sc = stacked();
  const planKey = sc.view().jobs.find((j) => j.purpose.what === "plan-pushes")!.purpose.key;
  sc.complete(planKey, { report: { pushes: [{ purpose: "verify", tryArgs: ["fuzzy", "-q", "x"], rebuild: 5 }], feedback: [] } });
  const [dry] = sc.settle();
  const push = sc.purpose(dry).push!;
  sc.complete(dry, { output: { command: ["./mach", "try", "fuzzy"], taskCount: 5, tasks: [], tryTaskConfig: {}, commits: [], warnings: [] } });
  sc.add({ type: "user-done", request: ID, key: `approve-push:${push}` });
  sc.add({ type: "try-pushed", request: ID, push, rev: "fed", url: "u" });
  sc.add({ type: "try-progress", request: ID, push, done: 2, total: 9, failures: 1, tests: { done: 3, total: 5 } });
  assert.ok(sc.settle().includes(`try-table:${push}:early`));
  sc.complete(`try-table:${push}:early`, { output: table([{ test: "a/test_a.js", config: "linux", result: "fail", failures: ["boom"], taskIds: ["T1"] }]) });
  assert.deepEqual(sc.settle(), [`author:i-test-a:try:${push}`]);
  sc.add({ type: "try-finished", request: ID, push, result: "failures", summary: "s" });
  sc.settle();
  sc.complete(`try-table:${push}:final`, { output: table(finalRows) });
  // A resume waits for the author's previous run to end.
  assert.ok(!sc.settle().includes(`author:i-test-a:try:${push}:final`));
  sc.complete(`author:i-test-a:try:${push}`, { report: fixed([sha("1")]) });
  sc.settle();
  const author = sc.view().byKey.get(`author:i-test-a:try:${push}`)![0].job;
  sc.complete(`import:${author}`, { output: imported(sha("1"), "Bug XXXXXXX - Fix a/test_a.js, r=smaug.", ["a/test_a.js"]) });
  return { sc, push };
}

describe("6. verify on try, watched", () => {
  it("the watch counts the test tasks the dry run asked for", () => {
    const sc = stacked();
    const planKey = sc.view().jobs.find((j) => j.purpose.what === "plan-pushes")!.purpose.key;
    sc.complete(planKey, { report: { pushes: [{ purpose: "verify", tryArgs: ["fuzzy", "-q", "x"], rebuild: 5 }], feedback: [] } });
    const [dry] = sc.settle();
    const push = sc.purpose(dry).push!;
    const job = (label: string, build?: string) => ({ label, platform: "linux", collection: "opt", group: "", symbol: "X", tier: 1, ...(build ? { build } : {}) });
    const jobs = [job("build-linux/opt"), job("test-linux/opt-xpcshell-1", "build-linux/opt"), job("test-linux/opt-xpcshell-2", "build-linux/opt")];
    sc.complete(dry, { output: { command: ["./mach", "try", "fuzzy"], taskCount: 3, tasks: [], tryTaskConfig: { rebuild: 5 }, commits: [], warnings: [], jobs } });
    sc.add({ type: "user-done", request: ID, key: `approve-push:${push}` });
    sc.add({ type: "try-pushed", request: ID, push, rev: "fed", url: "u" });
    assert.ok(sc.settle().includes(`watch:${push}`));
    const file = `/state/requests/${ID}/data/expect-${push}.json`;
    const plan = sc.plan(`watch:${push}`);
    assert.deepEqual(plan.cli?.args, ["watch", "fed", "--expect", file]);
    assert.deepEqual(plan.files, [{ path: file, content: JSON.stringify({ "test-linux/opt-xpcshell-1": 5, "test-linux/opt-xpcshell-2": 5 }) + "\n" }]);
  });
});

describe("6. verify on try, early then final", () => {
  const old = { test: "a/test_a.js", config: "linux", result: "fail", failures: ["boom"], taskIds: ["T1"] };
  it("the final run resumes the author with only the rows the early one didn't have", () => {
    const { sc, push } = earlyThenFinal([old, { test: "a/test_a.js", config: "mac", result: "fail", failures: ["bang"], taskIds: ["T2"] }]);
    sc.settle();
    // Matched by its group's test, not its folder: it goes as soon as the author's last run ends.
    assert.ok(sc.view().byKey.has(`author:i-test-a:try:${push}:final`));
    assert.ok(!sc.view().jobs.some((j) => j.purpose.key.startsWith(`author:i-test-b:try:${push}`)));
    const message = sc.plan(`author:i-test-a:try:${push}:final`).agent?.message ?? "";
    assert.match(message, /a\/test_a.js on mac: bang/);
    assert.doesNotMatch(message, /on linux/);
  });

  it("the final run doesn't resume the author when nothing is new", () => {
    const { sc, push } = earlyThenFinal([old]);
    assert.ok(!sc.settle().includes(`author:i-test-a:try:${push}:final`));
    assert.ok(!sc.view().byKey.has(`author:i-test-a:try:${push}:final`));
  });
});

function verified(reportA?: object): Scenario {
  const sc = stacked(reportA);
  const planKey = sc.view().jobs.find((j) => j.purpose.what === "plan-pushes")!.purpose.key;
  sc.complete(planKey, { report: { pushes: [{ purpose: "verify", tryArgs: ["fuzzy", "-q", "x"], rebuild: 5 }], feedback: [] } });
  const [dry] = sc.settle();
  const push = sc.purpose(dry).push!;
  sc.complete(dry, { output: { command: ["./mach", "try", "fuzzy"], taskCount: 5, tasks: [], tryTaskConfig: {}, commits: [], warnings: [] } });
  sc.add({ type: "user-done", request: ID, key: `approve-push:${push}` });
  sc.add({ type: "try-pushed", request: ID, push, rev: "fed", url: "u" });
  sc.add({ type: "try-finished", request: ID, push, result: "green", summary: "green" });
  sc.settle();
  sc.complete(`try-table:${push}:final`, { output: table() });
  sc.settle();
  return sc;
}

describe("review fixes", () => {
  it("a fix made without reproducing the failure waits for you: no import, no review", () => {
    const sc = workList([group("ka", "a/test_a.js", "boom")]);
    investigating(sc, "i-test-a");
    sc.complete("author:i-test-a:initial", { report: fixed([sha("1")], { reproduction: { reproduced: false } }) });
    assert.equal(sc.state().items["i-test-a"].state, "blocked");
    assert.ok(!sc.settle().some((k) => k.startsWith("import:")));
  });

  it("asks you for a reviewer when mach's suggestion is the one Phabricator doesn't know", () => {
    const sc = submitting();
    const { deps: _d, review: _r, replyDrafts: _rd, id, ...p } = sc.state().patches["p-test-a"];
    sc.add({ type: "patch", request: ID, patch: id, ...p, title: "Bug 999 - Fix a, r=#gone-reviewers." });
    reviewersChecked(sc, ["#gone-reviewers"]);
    sc.complete("reviewers:root", { output: { files: [], suggestions: [{ name: "#gone-reviewers", source: "recent" }] } });
    const [own] = sc.settle();
    sc.complete(own, { output: { files: [], suggestions: [{ name: "#gone-reviewers", source: "recent" }] } });
    // Its rotation is tried too.
    const [candidates] = sc.settle();
    assert.deepEqual(sc.plan(candidates).cli?.args, ["check-reviewers", "#gone-reviewers", "#gone-reviewers-rotation"]);
    sc.complete(candidates, { output: { unknown: ["#gone-reviewers", "#gone-reviewers-rotation"] } });
    assert.ok(!sc.settle().some((k) => k.startsWith("rewrite-reviewers:")), "no rewrite that can't help");
    assert.ok(sc.open().includes("reviewers:root:p-test-a"));
    // The one you give is used.
    sc.add({ type: "reviewer-set", request: ID, patch: "p-test-a", reviewer: "smaug" });
    sc.add({ type: "user-done", request: ID, key: "reviewers:root:p-test-a" });
    const [rewrite] = sc.settle();
    assert.match(JSON.parse(sc.plan(rewrite).files![0].content)[sha("f")].message, /^Bug 999 - Fix a, r=smaug\./);
  });

  it("uses a group's rotation when Phabricator doesn't know the group mach suggests", () => {
    const sc = submitting();
    const { deps: _d, review: _r, replyDrafts: _rd, id, ...p } = sc.state().patches["p-test-a"];
    sc.add({ type: "patch", request: ID, patch: id, ...p, title: "Bug 999 - Fix a" });
    reviewersChecked(sc);
    sc.complete("reviewers:root", { output: { files: [], suggestions: [{ name: "#ai-frontend-reviewers", source: "mots" }] } });
    // Its rotation before mach's next suggestion.
    sc.complete(sc.settle()[0], { output: { files: [], suggestions: [{ name: "#ai-frontend-reviewers", source: "mots" }, { name: "#firefox-desktop-core-reviewers", source: "mots" }] } });
    sc.complete(sc.settle()[0], { output: { unknown: ["#ai-frontend-reviewers"] } });
    const [rewrite] = sc.settle();
    assert.match(JSON.parse(sc.plan(rewrite).files![0].content)[sha("f")].message, /^Bug 999 - Fix a, r=#ai-frontend-reviewers-rotation\./);
  });
});

describe("6. verify on try, again", () => {
  it("leaves out a push you declined, without planning again; the plan's others still count", () => {
    const sc = stacked();
    const planKey = sc.view().jobs.find((j) => j.purpose.what === "plan-pushes")!.purpose.key;
    const two = [1, 2].map((n) => ({ purpose: `p${n}`, tryArgs: ["fuzzy", "-q", `x${n}`], rebuild: 5 }));
    sc.complete(planKey, { report: { pushes: two, feedback: [] } });
    const dries = sc.settle();
    for (const d of dries) sc.complete(d, { output: { command: ["./mach", "try", "fuzzy"], taskCount: 5, tasks: [], tryTaskConfig: {}, commits: [], warnings: [] } });
    sc.settle();
    const [keep, drop] = dries.map((d) => sc.purpose(d).push!);
    sc.add({ type: "try-declined", request: ID, push: drop, text: "too slow" });
    assert.deepEqual(sc.settle(), [], "no new plan");
    assert.deepEqual(sc.open(), [`approve-push:${keep}`]);
    sc.add({ type: "user-done", request: ID, key: `approve-push:${keep}` });
    sc.add({ type: "try-pushed", request: ID, push: keep, rev: "fed", url: "u" });
    sc.add({ type: "try-finished", request: ID, push: keep, result: "green", summary: "green" });
    sc.settle();
    sc.complete(`try-table:${keep}:final`, { output: table() });
    sc.settle();
    assert.equal(sc.state().step, "meta bug");
  });

  it("sends a push you revise back to the agent that planned it, in its session; what it returns replaces that push and the plan's others still waiting; and its replacement too", () => {
    const sc = stacked();
    const planKey = sc.view().jobs.find((j) => j.purpose.what === "plan-pushes")!.purpose.key;
    const two = [1, 2].map((n) => ({ purpose: `p${n}`, tryArgs: ["fuzzy", "-q", `x${n}`], rebuild: 5 }));
    sc.complete(planKey, { report: { pushes: two, feedback: [] } });
    const dryOut = { command: ["./mach", "try", "fuzzy"], taskCount: 5, tasks: [], tryTaskConfig: {}, commits: [], warnings: [] };
    const dries = sc.settle();
    for (const d of dries) sc.complete(d, { output: dryOut });
    sc.settle();
    const [keep, drop] = dries.map((d) => sc.purpose(d).push!);
    sc.add({ type: "try-declined", request: ID, push: drop, text: "on mac instead", replan: true });
    const [rev1] = sc.settle();
    assert.equal(rev1, `${planKey}:revise:${shortHash([drop]).slice(0, 8)}`);
    const p1 = sc.plan(rev1);
    assert.equal(p1.name, "plan-try-pushes");
    assert.equal(p1.cwd, sc.plan(planKey).cwd);
    assert.equal(p1.agent?.sessionId, sc.plan(planKey).agent?.sessionId);
    assert.equal(p1.agent?.resume, true);
    assert.ok(p1.agent?.message?.includes(`push ${drop} (\`./mach try fuzzy\`): “on mac instead”`), String(p1.agent?.message));
    assert.deepEqual(sc.open(), [`approve-push:${keep}`], "the plan's other push still waits for you");
    assert.ok(p1.agent?.message?.includes(`still waiting for the user's approval: ${keep} (`), "its planner may replace it too");

    sc.complete(rev1, { report: { pushes: [{ purpose: "mac", tryArgs: ["fuzzy", "-q", "mac"], rebuild: 5 }], feedback: [] } });
    const [dry1] = sc.settle();
    const v1 = sc.purpose(dry1).push!;
    assert.equal(v1, `${keep}-v1`);
    sc.complete(dry1, { output: dryOut });
    sc.settle();
    assert.deepEqual(sc.open(), [`approve-push:${v1}`], "the other push replaced by the revision");
    assert.equal(sc.state().pushes[keep].withdrawn, true);
    assert.deepEqual(sc.state().pushes[v1].revises, [drop], "its row says what you asked");
    assert.match(String(p1.agent?.message), /Say in `answer` what you changed and why/);

    // Its replacement revised the same way: a second round, in the same session, the earlier ones standing.
    sc.add({ type: "try-declined", request: ID, push: v1, text: "fewer jobs", replan: true });
    const [rev2] = sc.settle();
    assert.equal(rev2, `${planKey}:revise:${shortHash([v1]).slice(0, 8)}`);
    assert.equal(sc.plan(rev2).agent?.sessionId, p1.agent?.sessionId);
    assert.match(String(sc.plan(rev2).agent?.message), new RegExp(`push ${v1} .*“fewer jobs”`));
    const two2 = [1, 2].map((n) => ({ purpose: `q${n}`, tryArgs: ["fuzzy", "-q", `y${n}`], rebuild: 5 }));
    sc.complete(rev2, { report: { pushes: two2, feedback: [] } });
    const dries2 = sc.settle();
    assert.deepEqual(dries2.map((d) => sc.purpose(d).push), [`${keep}-v2-1`, `${keep}-v2-2`]);
  });

  it("a push whose query selected nothing goes back to its planner, once, before you see it", () => {
    const sc = stacked();
    const planKey = sc.view().jobs.find((j) => j.purpose.what === "plan-pushes")!.purpose.key;
    sc.complete(planKey, { report: { pushes: [{ purpose: "mac", tryArgs: ["fuzzy", "-q", "'mac"], rebuild: 1 }], feedback: [] } });
    const nothing = { command: ["./mach", "try", "fuzzy"], taskCount: 5, tasks: [], tryTaskConfig: {}, commits: [], warnings: [`-q "'mac" selected nothing: no task of the push matches it (…those need --full).`] };
    const [dry] = sc.settle();
    const push = sc.purpose(dry).push!;
    sc.complete(dry, { output: nothing });
    const [rev] = sc.settle();
    assert.equal(rev, `${planKey}:revise:${shortHash([push]).slice(0, 8)}`);
    assert.match(String(sc.plan(rev).agent?.message), /its dry run: -q "'mac" selected nothing/);
    assert.equal(sc.state().pushes[push].withdrawn, true);
    sc.complete(rev, { report: { pushes: [{ purpose: "mac", tryArgs: ["fuzzy", "--full", "-q", "'mac"], rebuild: 1 }], answer: "added --full", feedback: [] } });
    const [dry2] = sc.settle();
    sc.complete(dry2, { output: nothing });
    sc.settle();
    assert.deepEqual(sc.open(), [`approve-push:${sc.purpose(dry2).push}`], "not twice: you see it, with its warning");
  });

  it("a revision of a first-round push made after the second round exists is handled in the third, the second standing", () => {
    const sc = stacked();
    const planKey = sc.view().jobs.find((j) => j.purpose.what === "plan-pushes")!.purpose.key;
    const two = [1, 2].map((n) => ({ purpose: `p${n}`, tryArgs: ["fuzzy", "-q", `x${n}`], rebuild: 5 }));
    sc.complete(planKey, { report: { pushes: two, feedback: [] } });
    const dryOut = { command: ["./mach", "try", "fuzzy"], taskCount: 5, tasks: [], tryTaskConfig: {}, commits: [], warnings: [] };
    const dries = sc.settle();
    for (const d of dries) sc.complete(d, { output: dryOut });
    sc.settle();
    const [first, second] = dries.map((d) => sc.purpose(d).push!);
    sc.add({ type: "try-declined", request: ID, push: second, text: "on mac", replan: true });
    const [rev1] = sc.settle();
    sc.complete(rev1, { report: { pushes: [{ purpose: "mac", tryArgs: ["fuzzy", "-q", "mac"], rebuild: 5 }], feedback: [] } });
    const [dry1] = sc.settle();
    sc.complete(dry1, { output: dryOut });
    sc.settle();
    const v1 = sc.purpose(dry1).push!;

    sc.add({ type: "try-declined", request: ID, push: first, text: "on windows", replan: true });
    const [rev2] = sc.settle();
    assert.equal(rev2, `${planKey}:revise:${shortHash([first]).slice(0, 8)}`);
    assert.match(String(sc.plan(rev2).agent?.message), new RegExp(`push ${first} .*“on windows”`));
    assert.doesNotMatch(String(sc.plan(rev2).agent?.message), /on mac/);
    assert.deepEqual(sc.open(), [`approve-push:${v1}`], "the second round stands");
    sc.complete(rev2, { report: { pushes: [{ purpose: "win", tryArgs: ["fuzzy", "-q", "win"], rebuild: 5 }], feedback: [] } });
    const [dry2] = sc.settle();
    assert.equal(sc.purpose(dry2).push, `${first}-v2`);
  });

  it("verifies nothing while an un-skip push that you didn't decline has no result", () => {
    const sc = stacked();
    sc.add({ type: "try-planned", request: ID, push: "unskip", purpose: "reproduce", command: ["./mach", "try"] });
    sc.add({ type: "try-pushed", request: ID, push: "unskip", rev: "def", url: "u" });
    sc.settle();
    const planKey = sc.view().jobs.find((j) => j.purpose.what === "plan-pushes")!.purpose.key;
    sc.complete(planKey, { report: { pushes: [{ purpose: "verify", tryArgs: ["fuzzy", "-q", "x"], rebuild: 5 }], feedback: [] } });
    assert.ok(!sc.settle().some((k) => k.startsWith("dry-run:")), "waits for the un-skip push's results");
    sc.add({ type: "try-finished", request: ID, push: "unskip", result: "green", summary: "green" });
    assert.ok(sc.settle().some((k) => k.startsWith("dry-run:")));
  });

  it("an un-skip push you declined doesn't hold verification back", () => {
    const sc = stacked();
    sc.add({ type: "try-planned", request: ID, push: "unskip", purpose: "reproduce", command: ["./mach", "try"] });
    sc.add({ type: "try-declined", request: ID, push: "unskip", text: "no" });
    sc.settle();
    const planKey = sc.view().jobs.find((j) => j.purpose.what === "plan-pushes")!.purpose.key;
    sc.complete(planKey, { report: { pushes: [{ purpose: "verify", tryArgs: ["fuzzy", "-q", "x"], rebuild: 5 }], feedback: [] } });
    assert.ok(sc.settle().some((k) => k.startsWith("dry-run:")));
  });

  it("with nothing left to push, counts the stack's pushes already made, and asks you when there are none", () => {
    const sc = stacked();
    const planKey = sc.view().jobs.find((j) => j.purpose.what === "plan-pushes")!.purpose.key;
    assert.match(String(sc.plan(planKey).files?.[1].content), /^\[/);
    sc.complete(planKey, { report: { pushes: [], feedback: [] } });
    sc.settle();
    assert.equal(sc.state().step, "verify on try", "nothing verified it");
    assert.deepEqual(sc.open(), ["unverified:root"]);

    // Planned again (the step redone): a push made and green, then a plan with nothing more to push.
    sc.add({ type: "step", request: ID, step: "verify on try" });
    const plan2 = sc.settle().find((k) => k.startsWith("plan:verify:"))!;
    sc.complete(plan2, { report: { pushes: [{ purpose: "verify", tryArgs: ["fuzzy", "-q", "x"], rebuild: 5 }], feedback: [] } });
    const [dry] = sc.settle();
    const push = sc.purpose(dry).push!;
    sc.complete(dry, { output: { command: ["./mach", "try", "fuzzy"], taskCount: 5, tasks: [], tryTaskConfig: {}, commits: [], warnings: [] } });
    sc.add({ type: "user-done", request: ID, key: `approve-push:${push}` });
    sc.add({ type: "try-pushed", request: ID, push, rev: "fed", url: "u" });
    sc.add({ type: "try-finished", request: ID, push, result: "green", summary: "green" });
    sc.add({ type: "step", request: ID, step: "verify on try" });
    // A new plan after an earlier push first finds what changed since.
    const sinceKey = sc.settle().find((k) => k.startsWith("since:"))!;
    assert.ok(sinceKey, "the stack's changes since its last push");
    assert.deepEqual(sc.plan(sinceKey).cli?.args.slice(0, 1), ["since"]);
    const p = Object.keys(sc.state().patches)[0];
    sc.complete(sinceKey, { output: { changes: [{ patch: p, status: "changed", old: "a".repeat(40), new: "b".repeat(40), interdiff: { diff: "-old\n+new\n", method: "same-parent" } }], removed: [] } });
    assert.equal(sc.state().pushChanges.root.since, push);
    assert.match(sc.state().pushChanges.root.changes[0].interdiffFile!, /^requests\/.*interdiff-.*-since-/);
    const plan3 = sc.settle().find((k) => k.startsWith("plan:verify:"))!;
    assert.match(String(sc.plan(plan3).agent?.vars?.since), /The stack was pushed before \(fed: green\)/);
    const sinceFile = JSON.parse(String(sc.plan(plan3).files?.find((f) => f.path.includes("/since-"))?.content));
    assert.equal(sinceFile.previousPush.rev, "fed");
    assert.equal(sinceFile.changes[0].status, "changed");
    sc.complete(plan3, { report: { pushes: [], feedback: [] } });
    sc.settle();
    assert.equal(sc.state().step, "meta bug");
  });

  it("withdraws the pushes planned for the stack's earlier code that weren't made", () => {
    const sc = stacked();
    const planKey = sc.view().jobs.find((j) => j.purpose.what === "plan-pushes")!.purpose.key;
    sc.complete(planKey, { report: { pushes: [{ purpose: "verify", tryArgs: ["fuzzy", "-q", "x"], rebuild: 5 }], feedback: [] } });
    const [dry] = sc.settle();
    const push = sc.purpose(dry).push!;
    sc.complete(dry, { output: { command: ["./mach", "try", "fuzzy"], taskCount: 5, tasks: [], tryTaskConfig: {}, commits: [], warnings: [] } });
    sc.settle();
    assert.deepEqual(sc.open(), [`approve-push:${push}`]);
    sc.add({ type: "step", request: ID, step: "verify on try" });
    sc.settle();
    assert.match(sc.state().pushes[push].declined ?? "", /^not needed anymore/);
    assert.equal(sc.state().pushes[push].withdrawn, true, "by the factory, not you");
    assert.deepEqual(sc.open(), []);
  });
});

describe("7. meta bug", () => {
  // verified() with test_a's patch made the skip-ifs group's annotation patch, and test_b's without a bug or draft if bugless.
  function annotated(bugless = false): Scenario {
    const sc = verified();
    const { deps: _d, review: _r, replyDrafts: _rd, bugDraft: _b, id, ...a } = sc.state().patches["p-test-a"];
    sc.add({ type: "patch", request: ID, patch: id, ...a, item: "i-annotations" });
    const { deps: _d2, review: _r2, replyDrafts: _rd2, id: idB, ...b } = sc.state().patches["p-test-b"];
    if (bugless) sc.add({ type: "patch", request: ID, patch: idB, ...b, bug: null, title: "Bug XXXXXXX - Fix test_b, r=smaug." });
    sc.add({ type: "user-done", request: ID, key: "file-bug:p-test-a:meta-bug-step" });
    return sc;
  }

  it("asks for the meta bug (no draft outside burndowns) for an annotation patch, and its number goes only in the annotation patches", () => {
    const sc = annotated(true);
    assert.ok(sc.settle().some((k) => k.startsWith("author:i-test-b:bug:")), "test_b's fix gets a bug from its author instead");
    assert.equal(sc.state().metaBug, undefined);
    assert.ok(!sc.view().jobs.some((j) => j.purpose.what === "meta-draft"));
    assert.deepEqual(sc.open(), ["meta-bug:root"]);
    sc.add({ type: "meta-bug", request: ID, bug: 999 });
    sc.add({ type: "user-done", request: ID, key: "meta-bug:root" });
    const [rewrite] = sc.settle();
    assert.match(rewrite, /^rewrite-bugs:root:/);
    assert.deepEqual(JSON.parse(sc.plan(rewrite).files![0].content), { [sha("d")]: { bug: 999 } }, "not test_b's fix, which has no bug");
    sc.complete(rewrite, { output: { mapping: { [sha("c")]: sha("e"), [sha("d")]: sha("f") } } });
    assert.equal(sc.state().patches["p-test-a"].title, "Bug 999 - Fix a/test_a.js, r=smaug.");
    assert.equal(sc.state().patches["p-test-a"].bug, 999);
    assert.equal(sc.state().patches["p-test-b"].bug, null);
  });

  it("a patch rebuilt from its author's commit, which says Bug XXXXXXX again, gets its bug back", () => {
    const sc = annotated();
    sc.add({ type: "meta-bug", request: ID, bug: 999 });
    sc.add({ type: "user-done", request: ID, key: "meta-bug:root" });
    const [rewrite] = sc.settle();
    sc.complete(rewrite, { output: { mapping: { [sha("c")]: sha("e"), [sha("d")]: sha("f") }, titles: { [sha("e")]: "Bug 1 - Fix b/test_b.js, r=smaug.", [sha("f")]: "Bug XXXXXXX - Fix a/test_a.js, r=smaug." } } });
    assert.equal(sc.state().patches["p-test-a"].title, "Bug XXXXXXX - Fix a/test_a.js, r=smaug.", "the commit's own title");
    assert.equal(sc.state().patches["p-test-a"].bug, 999);
    const [again] = sc.settle();
    assert.match(again, /^rewrite-bugs:root:/);
    assert.deepEqual(JSON.parse(sc.plan(again).files![0].content), { [sha("f")]: { bug: 999 } });
  });

  it("a patch already on Phabricator gets its Differential Revision line along with its bug", () => {
    const sc = annotated();
    const { deps: _d, review: _r, replyDrafts: _rd, id, ...p } = sc.state().patches["p-test-a"];
    sc.add({ type: "patch", request: ID, patch: id, ...p, revision: 7 });
    sc.add({ type: "meta-bug", request: ID, bug: 999 });
    sc.add({ type: "user-done", request: ID, key: "meta-bug:root" });
    const [rewrite] = sc.settle();
    assert.match(rewrite, /^rewrite-bugs:root:/);
    const plan = sc.plan(rewrite);
    assert.deepEqual(plan.cli?.args.slice(-2), ["--edits", plan.files![0].path]);
    assert.deepEqual(JSON.parse(plan.files![0].content), { [sha("d")]: { bug: 999, revision: "https://phabricator.services.mozilla.com/D7" } });
  });

  it("asks you to file each patch's drafted bug only now; no meta bug when every patch has its own", () => {
    const draft = { product: "Core", component: "XPCOM", summary: "s", description: "d" };
    const sc = verified({ bugDraft: draft });
    assert.equal(sc.state().step, "meta bug");
    const step7 = sc.events.findIndex((e) => e.type === "step" && e.step === "meta bug");
    assert.deepEqual(sc.events.flatMap((e, i) => (e.type === "needs-user" && e.key.startsWith("file-bug:") ? [i > step7] : [])), [true]);
    assert.deepEqual(sc.open().sort(), ["file-bug:p-test-a:meta-bug-step"]);
    assert.equal(sc.state().metaBug, undefined);
    const n = sc.state().needsUser.find((x) => x.key.startsWith("file-bug:"))!;
    assert.equal(n.patch, "p-test-a");
    assert.equal(n.item, "i-test-a");
    // The bug number arrives some other way than set-bug (e.g. a rewrite): the ⚑ goes.
    const { deps: _d, review: _r, replyDrafts: _rd, id, ...p } = sc.state().patches["p-test-a"];
    sc.add({ type: "patch", request: ID, patch: id, ...p, bug: 555, title: p.title.replace(/^Bug X+/, "Bug 555") });
    sc.settle();
    assert.deepEqual(sc.open(), []);
    assert.equal(sc.state().step, "submit");
  });
});

describe("file-bug raised before step 7 by an earlier version", () => {
  it("is cleared when the orchestrator next plans the request", () => {
    const draft = { product: "Core", component: "XPCOM", summary: "s", description: "d" };
    const sc = twoReviewed({ bugDraft: draft });
    // As the earlier version left it: the patch's bug to file, open during step 5.
    sc.add({ type: "needs-user", request: ID, key: "file-bug:p-test-a", action: "File the bug", detail: "", patch: "p-test-a", item: "i-test-a" });
    assert.equal(sc.state().step, "stack");
    sc.step();
    assert.deepEqual(sc.of("user-done").map((e) => e.key), ["file-bug:p-test-a"]);
    assert.deepEqual(sc.open(), []);
  });

  it("is cleared at step 7, leaving one ⚑ for the patch", () => {
    const sc = verified({ bugDraft: { product: "Core", component: "XPCOM", summary: "s", description: "d" } });
    sc.add({ type: "needs-user", request: ID, key: "file-bug:p-test-a", action: "File the bug", detail: "", patch: "p-test-a", item: "i-test-a" });
    sc.settle();
    assert.deepEqual(sc.open().sort(), ["file-bug:p-test-a:meta-bug-step"]);
  });
});

describe("file-bug at a redone step 7", () => {
  it("is cleared when the step is redone, and asked again when step 7 comes back", () => {
    const sc = verified({ bugDraft: { product: "Core", component: "XPCOM", summary: "s", description: "d" } });
    assert.ok(sc.open().includes("file-bug:p-test-a:meta-bug-step"));
    sc.add({ type: "step", request: ID, step: "verify on try" });
    sc.settle();
    assert.ok(!sc.open().some((k) => k.startsWith("file-bug:")));
    // As if the new pushes were green.
    sc.add({ type: "step", request: ID, step: "meta bug" });
    sc.settle();
    assert.ok(sc.open().includes("file-bug:p-test-a:meta-bug-step@1"));
  });
});

function submitting(): Scenario {
  const sc = verified();
  // You file test_a's drafted bug: 999.
  const { deps: _d, review: _r, replyDrafts: _rd, id, ...p } = sc.state().patches["p-test-a"];
  sc.add({ type: "patch", request: ID, patch: id, ...p, bug: 999, bugFromYou: true });
  sc.add({ type: "user-done", request: ID, key: "file-bug:p-test-a:meta-bug-step" });
  sc.settle();
  const rewrite = sc.view().jobs.find((j) => j.purpose.key.startsWith("rewrite-bugs:"))!.purpose.key;
  sc.complete(rewrite, { output: { mapping: { [sha("c")]: sha("e"), [sha("d")]: sha("f") } } });
  reviewersChecked(sc);
  return sc;
}

// Since the stack, its branch is read back from git and its reviewers checked: git as the state has it, every
// reviewer known (unless unknown says otherwise).
function reviewersChecked(sc: Scenario, unknown: string[] = []): void {
  for (;;) {
    sc.settle();
    const jobs = sc.view().jobs.filter((x) => !x.end && (x.purpose.key.startsWith("sync:") || x.purpose.what === "check-reviewers"));
    if (!jobs.length) return;
    for (const j of jobs) {
      if (j.purpose.what === "check-reviewers") {
        sc.complete(j.purpose.key, { output: { unknown } });
        continue;
      }
      const s = sc.state();
      sc.complete(j.purpose.key, {
        output: s.stacks[j.purpose.stack!].order.map((pid) => {
          const p = s.patches[pid];
          return { sha: p.sha, title: p.title, bug: p.bug, reviewers: [], files: [], insertions: 1, deletions: 0, testOnly: true, ...(p.revision !== undefined ? { revision: p.revision } : {}) };
        }),
      });
    }
  }
}

describe("8. submit", () => {
  // A patch event changing these fields of a patch, as an effort estimate or an import would.
  const setPatch = (sc: Scenario, pid: string, fields: object) => {
    const { deps: _d, review: _r, replyDrafts: _rd, id, ...p } = sc.state().patches[pid];
    sc.add({ type: "patch", request: ID, patch: id, ...p, ...fields });
  };
  const orderKeys = (sc: Scenario) => sc.view().jobs.filter((j) => j.purpose.key.startsWith("order:root:")).map((j) => j.purpose.key);

  it("a stack you submitted before the factory asked (at verify on try) goes to review once its revisions show up", () => {
    const sc = stacked();
    assert.equal(sc.state().step, "verify on try");
    setPatch(sc, "p-test-a", { revision: 11 });
    sc.settle();
    assert.equal(sc.state().step, "verify on try", "not all its patches are on Phabricator yet");
    setPatch(sc, "p-test-b", { revision: 12 });
    sc.settle();
    assert.equal(sc.state().step, "review comments");
    assert.equal(sc.state().items["i-test-a"].state, "waiting for review");
    // Verifying again after review (a redo-step): it stays there to plan its push.
    sc.add({ type: "step", request: ID, step: "verify on try" });
    assert.deepEqual(sc.settle().filter((k) => k.startsWith("plan:verify:")).length, 1);
    assert.equal(sc.state().step, "verify on try");
  });

  it("orders an unsubmitted stack again when a patch's effort changes, and reorders it", () => {
    const sc = submitting();
    assert.equal(sc.state().step, "submit");
    assert.deepEqual(sc.state().stacks.root.order, ["p-test-b", "p-test-a"]);
    const before = orderKeys(sc);
    setPatch(sc, "p-test-b", { effort: 5 });
    const ord = sc.settle().find((k) => k.startsWith("order:root:"))!;
    assert.ok(ord && !before.includes(ord), "ordered again");
    const input = JSON.parse(sc.plan(ord).files![0].content);
    assert.deepEqual(input.patches.find((p: { id: string }) => p.id === "p-test-b").effort, 5);
    assert.deepEqual(input.previous, ["p-test-b", "p-test-a"]);
    sc.complete(ord, { output: { order: ["p-test-a", "p-test-b"], flippedSoftDeps: [] } });
    const [re] = sc.settle();
    assert.equal(re, `re${ord}`);
    assert.deepEqual(sc.plan(re).cli?.args.slice(-2), ["--order", `${sha("f")},${sha("e")}`]);
  });

  it("doesn't order a stack again once a patch of it has a revision", () => {
    const sc = submitting();
    setPatch(sc, "p-test-b", { revision: 100 });
    sc.settle();
    const before = orderKeys(sc);
    setPatch(sc, "p-test-b", { effort: 5 });
    assert.ok(!sc.settle().some((k) => k.startsWith("order:") || k.startsWith("reorder:")));
    assert.deepEqual(orderKeys(sc), before);
  });

  it("checks the stack, asks you to submit, and notices the Differential Revision trailers", () => {
    const sc = submitting();
    assert.equal(sc.state().step, "submit");
    assert.deepEqual(sc.plan("reviewers:root").cli?.args, ["reviewers", "a/test_b.js", "a/test_a.js", "--repo", `/wt/${ID}-root`]);
    sc.complete("reviewers:root", { output: { files: [], suggestions: [{ name: "smaug", source: "mots" }] } });
    const [check] = sc.settle();
    assert.match(check, /^check:root:/);
    assert.deepEqual(JSON.parse(sc.plan(check).files![0].content).map((p: { result: string }) => p.result), ["green"]);
    sc.complete(check, { output: { ok: true, failures: [] } });
    assert.deepEqual(sc.settle(), [], "nothing looks for revisions before you copy the moz-phab command");
    assert.deepEqual(sc.open(), ["submit:root"]);
    sc.add({ type: "submit-copied", request: ID, stack: "root" });
    assert.deepEqual(sc.settle(), ["import-submit:root:0"]);
    sc.complete("import-submit:root:0", { output: imported(sha("e"), "Bug 22 - Fix test_b, r=smaug.", [], 22).concat(imported(sha("f"), "Bug 999 - Fix a, r=smaug.", [], 999)) });
    assert.deepEqual(sc.settle(), []);
    sc.now += 2 * 60_000;
    assert.deepEqual(sc.settle(), ["import-submit:root:1"]);
    const withRevisions = [
      { ...imported(sha("e"), "Bug 22 - Fix test_b, r=smaug.", [], 22)[0], revision: 100 },
      { ...imported(sha("f"), "Bug 999 - Fix a, r=smaug.", [], 999)[0], revision: 101 },
    ];
    sc.complete("import-submit:root:1", { output: withRevisions });
    sc.settle();
    assert.equal(sc.state().patches["p-test-a"].revision, 101);
    assert.deepEqual(sc.open(), []);
    assert.equal(sc.state().items["i-test-a"].state, "waiting for review");
    assert.equal(sc.state().step, "review comments");
  });

  it("replaces a reviewer Phabricator doesn't know with the suggested one", () => {
    const sc = submitting();
    const { deps: _d, review: _r, replyDrafts: _rd, id, ...p } = sc.state().patches["p-test-a"];
    sc.add({ type: "patch", request: ID, patch: id, ...p, title: "Bug 999 - Fix a, r=#testing-reviewers." });
    const [known] = sc.settle();
    assert.deepEqual(sc.plan(known).cli?.args, ["check-reviewers", "smaug", "#testing-reviewers"]);
    sc.complete(known, { output: { unknown: ["#testing-reviewers"] } });
    sc.complete("reviewers:root", { output: { files: [], suggestions: [{ name: "#dom-core", source: "mots" }] } });
    const [own] = sc.settle();
    assert.deepEqual(sc.plan(own).cli?.args, ["reviewers", "a/test_a.js", "--repo", `/wt/${ID}-root`], "the suggestion for its own files");
    sc.complete(own, { output: { files: [], suggestions: [{ name: "#xpcshell-reviewers", source: "mots" }] } });
    sc.complete(sc.settle()[0], { output: { unknown: [] } });
    const [rewrite] = sc.settle();
    assert.equal(JSON.parse(sc.plan(rewrite).files![0].content)[sha("f")].message, "Bug 999 - Fix a, r=#xpcshell-reviewers.\n\nBody.\n");
    sc.complete(rewrite, { output: { mapping: { [sha("f")]: sha("9") } } });
    assert.equal(sc.state().patches["p-test-a"].title, "Bug 999 - Fix a, r=#xpcshell-reviewers.", "the page shows the new reviewer");
    reviewersChecked(sc);
    assert.equal(sc.view().jobs.filter((j) => j.purpose.key.startsWith("rewrite-reviewers:")).length, 1, "rewritten once");
  });

  it("a reviewer rewrite gives a submitted patch its Differential Revision line, merged with its new message", () => {
    const sc = submitting();
    const { deps: _d, review: _r, replyDrafts: _rd, id, ...p } = sc.state().patches["p-test-a"];
    sc.add({ type: "patch", request: ID, patch: id, ...p, title: "Bug 999 - Fix a", revision: 101 });
    sc.complete("reviewers:root", { output: { files: [], suggestions: [{ name: "#dom-core", source: "mots" }] } });
    const own = sc.settle().find((k) => k.startsWith("reviewers:"))!;
    sc.complete(own, { output: { files: [], suggestions: [] } });
    sc.complete(sc.settle()[0], { output: { unknown: [] } });
    const [rewrite] = sc.settle();
    assert.match(rewrite, /^rewrite-reviewers:root:/);
    assert.deepEqual(JSON.parse(sc.plan(rewrite).files![0].content), {
      [sha("f")]: { message: "Bug 999 - Fix a, r=#dom-core.\n\nBody.\n", bug: 999, revision: "https://phabricator.services.mozilla.com/D101" },
    });
  });

  it("adds the suggested reviewer to patches without r=, then shows failed checks to you", () => {
    const sc = submitting();
    const s = sc.state();
    const { deps: _d, review: _r, replyDrafts: _rd, id, ...p } = s.patches["p-test-a"];
    sc.add({ type: "patch", request: ID, patch: id, ...p, title: "Bug 999 - Fix a" });
    sc.complete("reviewers:root", { output: { files: [], suggestions: [{ name: "#dom-core", source: "mots" }] } });
    sc.complete(sc.settle()[0], { output: { files: [], suggestions: [] } });
    sc.complete(sc.settle()[0], { output: { unknown: [] } });
    const [rewrite] = sc.settle();
    assert.match(rewrite, /^rewrite-reviewers:root:/, "without a suggestion for its own files, the stack's");
    const edits = JSON.parse(sc.plan(rewrite).files![0].content);
    assert.equal(edits[sha("f")].message, "Bug 999 - Fix a, r=#dom-core.\n\nBody.\n");
    sc.complete(rewrite, { output: { mapping: { [sha("f")]: sha("9") } } });
    assert.equal(sc.state().patches["p-test-a"].title, "Bug 999 - Fix a, r=#dom-core.");
    reviewersChecked(sc);
    assert.deepEqual(sc.plan(sc.view().jobs.filter((j) => j.purpose.what === "check-reviewers").at(-1)!.purpose.key).cli?.args, ["check-reviewers", "smaug", "#dom-core"]);
    const check = sc.view().jobs.find((j) => !j.end && j.purpose.key.startsWith("check:root:"))!.purpose.key;
    const job = sc.complete(check, { output: { ok: false, failures: [{ rule: "try", message: "try isn't green" }] } });
    sc.settle();
    assert.deepEqual(sc.open(), [`failed:${job}`]);
  });
});

function inReview(): Scenario {
  const sc = submitting();
  sc.complete("reviewers:root", { output: { files: [], suggestions: [] } });
  const [check] = sc.settle();
  sc.complete(check, { output: { ok: true, failures: [] } });
  sc.add({ type: "submit-copied", request: ID, stack: "root" });
  sc.settle();
  sc.complete("import-submit:root:0", {
    output: [
      { ...imported(sha("e"), "Bug 22 - Fix test_b, r=smaug.", [], 22)[0], revision: 100 },
      { ...imported(sha("f"), "Bug 999 - Fix a, r=smaug.", [], 999)[0], revision: 101 },
    ],
  });
  sc.settle();
  return sc;
}

const polled = (status: string, comments: unknown[] = [], reviewer = "accepted") => [
  { revision: 100, phid: "x", title: "t", status, reviewers: [{ name: "smaug", status: reviewer }], comments: [] },
  { revision: 101, phid: "y", title: "t", status, reviewers: [{ name: "smaug", status: reviewer }], comments },
];

function command(sc: Scenario, c: Record<string, unknown>): void {
  const cmd = { v: 1, id: `c-${sc.events.length}`, t: new Date(sc.now).toISOString(), request: ID, ...c } as Command;
  for (const e of commandEffects(cmd, { config, state: sc.state(), view: sc.view(), exists: () => false, plan: (j) => sc.plans.get(j) })) {
    if (e.type === "event") sc.add(e.event);
    if (e.type === "start") sc.startJob(e.plan);
  }
}

describe("10. landing with a patch landed", () => {
  it("leaves the landed patch out of the rewrite, its Differential Revision edit too", () => {
    const sc = inReview();
    const [d100, d101] = polled("accepted");
    sc.complete("poll:0", { output: [{ ...d100, status: "published" }, d101] });
    sc.settle();
    const key = sc.view().jobs.find((j) => !j.end && j.purpose.key.startsWith("order-landable:"))!.purpose.key;
    sc.complete(key, { output: { order: ["p-test-a"], flippedSoftDeps: [], landable: ["p-test-a"] } });
    const rw = sc.settle().find((k) => k.startsWith("rewrite-land:"))!;
    const plan = sc.plan(rw);
    assert.deepEqual(Object.keys(JSON.parse(plan.files![0].content)), [sc.state().patches["p-test-a"].sha]);
  });
});

function backedOutAndAsked(): Scenario {
  const sc = inReview();
  sc.complete("poll:0", { output: polled("published") });
  sc.settle();
  sc.now += 4 * 3_600_000;
  sc.settle();
  const poll = sc.view().jobs.find((j) => !j.end && j.purpose.key.startsWith("poll:"))!.purpose.key;
  sc.complete(poll, { output: polled("accepted") });
  sc.settle();
  const pushes = [{ t: "2026-10-15T10:00:00Z", kind: "landed", by: "me", title: "t" }, { t: "2026-10-15T11:00:00Z", kind: "backed out", by: "sheriff", title: "r" }];
  const backout = { t: new Date(sc.now).toISOString(), by: "sheriff", text: "Backed out for causing mochitest failures @test_b.js." };
  for (const [p, bug] of [["p-test-b", 22], ["p-test-a", 999]] as const) sc.complete(sc.view().jobs.find((j) => !j.end && j.purpose.key.startsWith(`backout-reason:${p}:`))!.purpose.key, { output: [{ bug, pushes, backout }] });
  sc.settle();
  const told = sc.view().jobs.find((j) => j.purpose.key.startsWith("author:i-test-b:backout:"))!.purpose.key;
  const job = sc.complete(told, { report: fixed([sha("5"), sha("7")]) });
  sc.settle();
  sc.complete(`import:${job}`, { output: [...imported(sha("5"), "Bug 22 - Fix test_b, r=smaug.", ["a/test_b.js"], 22).map((c) => ({ ...c, revision: 100 })), ...imported(sha("7"), "Bug 23 - Fix the product race, r=smaug.", ["a/b.mjs"], 23)] });
  for (let i = 0; i < 6; i++) {
    for (const k of sc.settle()) {
      if (k.startsWith("msg:")) sc.complete(k, { output: "m" });
      else if (k.startsWith("lint:")) sc.complete(k, { output: lintOk });
      else if (k.startsWith("review:")) sc.complete(k, { report: ok });
      else if (k.startsWith("rewrite-review:")) sc.complete(k, { output: { mapping: { [sha("5")]: sha("6") } } });
      else if (k.startsWith("interdiff:")) sc.complete(k, { output: { diff: "-a\n+b\n", method: "same-parent" } });
      else if (k.startsWith("append:")) sc.complete(k, { output: { mapping: { [sha("7")]: sha("8") } } });
    }
  }
  return sc;
}

describe("10. backouts", () => {
  it("a backout no poll saw land is found from Phabricator's reopen", () => {
    const sc = inReview();
    sc.complete("poll:0", { output: polled("accepted") });
    sc.settle();
    sc.now += 4 * 3_600_000;
    sc.settle();
    const poll = sc.view().jobs.find((j) => !j.end && j.purpose.key.startsWith("poll:"))!.purpose.key;
    const reopenedAt = new Date(sc.now - 3_600_000).toISOString();
    sc.complete(poll, { output: polled("accepted").map((x) => ({ ...x, reopenedAt })) });
    sc.settle();
    assert.equal(sc.state().reopened["p-test-a"], reopenedAt);
    assert.ok(sc.view().jobs.some((j) => j.purpose.key.startsWith("backout-reason:p-test-a:")));
  });

  // Both patches landed, then a sheriff backed both out for test_b's failure: their revisions reopen.
  function backedOut(text = "Backed out for causing mochitest failures @test_b.js.\n* [Failure Log](https://treeherder.mozilla.org/logviewer?job_id=1)"): Scenario {
    const sc = inReview();
    sc.complete("poll:0", { output: polled("published") });
    sc.settle();
    assert.equal(sc.state().step, "done");
    assert.ok(!sc.view().jobs.some((j) => j.purpose.key.startsWith("backout-reason:")), "Bugzilla isn't asked while nothing reopens");
    sc.now += 4 * 3_600_000;
    sc.settle();
    const poll = sc.view().jobs.find((j) => !j.end && j.purpose.key.startsWith("poll:"))!.purpose.key;
    sc.complete(poll, { output: polled("accepted") });
    sc.settle();
    assert.equal(sc.state().step, "landing");
    const key = sc.view().jobs.find((j) => !j.end && j.purpose.key.startsWith("backout-reason:p-test-b:"))!.purpose.key;
    assert.deepEqual(sc.plan(key).cli?.args, ["landings", "22"]);
    const pushes = [
      { t: "2026-10-15T10:00:00Z", kind: "landed", by: "me", title: "t" },
      { t: "2026-10-15T11:00:00Z", kind: "backed out", by: "sheriff", title: 'Revert "Bug 22, Bug 999 - …"' },
    ];
    const backout = { t: new Date(sc.now).toISOString(), by: "sheriff", text };
    sc.complete(key, { output: [{ bug: 22, pushes, backout }] });
    sc.complete(sc.view().jobs.find((j) => !j.end && j.purpose.key.startsWith("backout-reason:p-test-a:"))!.purpose.key, { output: [{ bug: 999, pushes, backout }] });
    sc.settle();
    return sc;
  }

  it("takes the request back to landing: the patch the failure names goes to its author, the other may land again", () => {
    const sc = backedOut();
    assert.equal(sc.state().step, "landing");
    assert.equal(sc.state().backouts["p-test-b"].reason, "Backed out for causing mochitest failures @test_b.js.\n* [Failure Log](https://treeherder.mozilla.org/logviewer?job_id=1)");
    assert.equal(sc.state().backouts["p-test-b"].culprit, true);
    assert.equal(sc.state().backouts["p-test-a"].culprit, false);
    assert.equal(sc.state().items["i-test-a"].state, "waiting for review", "not landed anymore");
    const told = sc.view().jobs.find((j) => j.purpose.key.startsWith("author:i-test-b:backout:p-test-b:"))!;
    assert.match(sc.plan(told.purpose.key).agent?.message ?? "", /landed, then was backed out:\nBacked out for causing mochitest failures @test_b\.js/);
    assert.ok(!sc.view().jobs.some((j) => j.purpose.key.startsWith("author:i-test-a:backout:")));
    const s = sc.state();
    assert.deepEqual(landingState(s, s.patches["p-test-a"]), { accepted: true, commentsAddressed: true, landed: false });
    assert.equal(landingState(s, s.patches["p-test-b"]).accepted, false, "not before a green try run of its fix");
  });

  it("a backout naming neither patch asks both authors; one finding it isn't its patch's may land again", () => {
    const sc = backedOut("Backed out for causing failures at test_other.html.");
    assert.equal(sc.state().backouts["p-test-a"].culprit, true);
    assert.equal(sc.state().backouts["p-test-b"].culprit, true);
    const told = sc.view().jobs.find((j) => j.purpose.key.startsWith("author:i-test-a:backout:"))!.purpose.key;
    sc.complete(told, { report: fixed([], { state: "left as-is", summary: "the log shows another test, which my patch doesn't touch" }) });
    sc.settle();
    assert.equal(sc.state().backouts["p-test-a"].culprit, false);
    assert.equal(landingState(sc.state(), sc.state().patches["p-test-a"]).accepted, true);
    assert.equal(sc.state().backouts["p-test-b"].culprit, true);
  });

  it("its fix, once reviewed, gets a try push of the failing jobs; green, it may land again", () => {
    const sc = backedOut();
    const told = sc.view().jobs.find((j) => j.purpose.key.startsWith("author:i-test-b:backout:"))!.purpose.key;
    const job = sc.complete(told, { report: fixed([sha("5")]) });
    sc.settle();
    sc.complete(`import:${job}`, { output: imported(sha("5"), "Bug 22 - Fix test_b, r=smaug.", ["a/test_b.js"], 22).map((c) => ({ ...c, revision: 100 })) });
    sc.settle();
    sc.complete(`msg:p-test-b:${sha("5")}`, { output: "m" });
    sc.settle();
    sc.complete(`lint:p-test-b:${sha("5")}`, { output: lintOk });
    sc.settle();
    sc.complete(`review:p-test-b:${job}`, { report: ok });
    const rw = sc.settle().find((k) => k.startsWith("rewrite-review:"))!;
    sc.complete(rw, { output: { mapping: { [sha("5")]: sha("6") } } });
    for (const k of sc.settle().filter((k) => k.startsWith("interdiff:"))) sc.complete(k, { output: { diff: "-a\n+b\n", method: "same-parent" } });
    sc.settle();
    assert.equal(sc.state().items["i-test-b"].state, "waiting for review");
    assert.match(sc.state().verifyAsked?.at(-1) ?? "", /^Verify D100 \(Bug 22 - Fix test_b, r=smaug\.\) after its backout/);
    sc.settle();
    const since = sc.view().jobs.find((j) => !j.end && j.purpose.key.startsWith("since:root:"));
    if (since) sc.complete(since.purpose.key, { output: { changes: [], removed: [] } });
    sc.settle();
    const plan = sc.view().jobs.find((j) => !j.end && j.purpose.key.startsWith("plan:verify:root:"))!.purpose.key;
    assert.match(String(sc.plan(plan).agent?.vars?.goal), /The user asked for this push: “Verify D100/);
    sc.complete(plan, { report: { pushes: [{ purpose: "rerun the failing job", tryArgs: ["fuzzy", "-q", "x"], rebuild: 5 }], feedback: [] } });
    const dry = sc.settle().find((k) => k.startsWith("dry-run:"))!;
    const push = sc.purpose(dry).push!;
    sc.complete(dry, { output: { command: ["./mach", "try", "fuzzy"], taskCount: 5, tasks: [], tryTaskConfig: {}, commits: [], warnings: [] } });
    sc.add({ type: "user-done", request: ID, key: `approve-push:${push}` });
    sc.add({ type: "try-pushed", request: ID, push, rev: "fed", url: "u" });
    sc.add({ type: "try-finished", request: ID, push, result: "green", summary: "green" });
    sc.settle();
    assert.equal(sc.state().backouts["p-test-b"].verified, true);
    assert.equal(landingState(sc.state(), sc.state().patches["p-test-b"]).accepted, true, "it may land again");
  });

  it("a push whose only failures are another test's still clears the backout's fix", () => {
    const sc = backedOut();
    const told = sc.view().jobs.find((j) => j.purpose.key.startsWith("author:i-test-b:backout:"))!.purpose.key;
    const job = sc.complete(told, { report: fixed([sha("5")]) });
    sc.settle();
    sc.complete(`import:${job}`, { output: imported(sha("5"), "Bug 22 - Fix test_b, r=smaug.", ["a/test_b.js"], 22).map((c) => ({ ...c, revision: 100 })) });
    sc.settle();
    sc.complete(`msg:p-test-b:${sha("5")}`, { output: "m" });
    sc.settle();
    sc.complete(`lint:p-test-b:${sha("5")}`, { output: lintOk });
    sc.settle();
    sc.complete(`review:p-test-b:${job}`, { report: ok });
    const rw = sc.settle().find((k) => k.startsWith("rewrite-review:"))!;
    sc.complete(rw, { output: { mapping: { [sha("5")]: sha("6") } } });
    for (const k of sc.settle().filter((k) => k.startsWith("interdiff:"))) sc.complete(k, { output: { diff: "-a\n+b\n", method: "same-parent" } });
    sc.settle();
    assert.equal(sc.state().items["i-test-b"].state, "waiting for review");
    assert.match(sc.state().verifyAsked?.at(-1) ?? "", /^Verify D100 \(Bug 22 - Fix test_b, r=smaug\.\) after its backout/);
    sc.settle();
    const since = sc.view().jobs.find((j) => !j.end && j.purpose.key.startsWith("since:root:"));
    if (since) sc.complete(since.purpose.key, { output: { changes: [], removed: [] } });
    sc.settle();
    const plan = sc.view().jobs.find((j) => !j.end && j.purpose.key.startsWith("plan:verify:root:"))!.purpose.key;
    assert.match(String(sc.plan(plan).agent?.vars?.goal), /The user asked for this push: “Verify D100/);
    sc.complete(plan, { report: { pushes: [{ purpose: "rerun the failing job", tryArgs: ["fuzzy", "-q", "x"], rebuild: 5 }], feedback: [] } });
    const dry = sc.settle().find((k) => k.startsWith("dry-run:"))!;
    const push = sc.purpose(dry).push!;
    sc.complete(dry, { output: { command: ["./mach", "try", "fuzzy"], taskCount: 5, tasks: [], tryTaskConfig: {}, commits: [], warnings: [] } });
    sc.add({ type: "user-done", request: ID, key: `approve-push:${push}` });
    sc.add({ type: "try-pushed", request: ID, push, rev: "fed", url: "u" });
    sc.add({ type: "try-finished", request: ID, push, result: "failures", summary: "1 failure" });
    sc.settle();
    for (const k of sc.view().jobs.filter((j) => !j.end && j.purpose.key.startsWith("collect:")).map((j) => j.purpose.key)) sc.complete(k, { output: [] });
    sc.complete(`try-table:${push}:final`, { output: table([{ test: "z/test_z.js", config: "linux", result: "fail", failures: ["zap"], taskIds: ["T2"] }]) });
    sc.settle();
    sc.complete(`triage:${push}:final:v2`, { report: { cells: [{ test: "z/test_z.js", config: "linux", verdict: "still failing", evidence: "unrelated" }], feedback: [] } });
    sc.settle();
    assert.equal(sc.state().backouts["p-test-b"].verified, true);
    assert.equal(landingState(sc.state(), sc.state().patches["p-test-b"]).accepted, true, "it may land again");
  });
});

describe("10. an answer after submission adding a commit", () => {
  it("doesn't put the new commit on a bug of its own when the first is on one", () => {
    const sc = inReview();
    sc.complete("poll:0", { output: polled("needs-review", [], "pending") });
    sc.settle();
    const plan = resumeAuthorPlan(ID, sc.view(), "i-test-a", "continue", { message: "fix the race too" }, "investigating");
    assert.ok(plan && plan !== "busy");
    plan.purpose.key = "author:i-test-a:continue:c-7";
    sc.startJob(plan);
    const draft = { product: "Firefox", component: "General", bugType: "defect", summary: "s", description: "d" };
    assert.throws(() => sc.complete("author:i-test-a:continue:c-7", { report: fixed([sha("f"), sha("7")], { bugDrafts: [{ commits: [sha("7")], draft }] }) }), (e: Error) => e instanceof InvalidReport && /first commit is on Bug 999/.test(e.message));
  });

  it("puts the new commit on top of the stack, for you to submit", () => {
    const sc = backedOutAndAsked();
    assert.ok(sc.state().stacks.root.order.includes("p-test-b-2"), String(sc.state().stacks.root.order));
    assert.ok(sc.state().needsUser.some((n) => n.key.startsWith("submit-new:root:")));
  });
});

describe("9. a try push of a submitted stack", () => {
  it("is planned when you ask, once, without the step going back", () => {
    const sc = inReview();
    sc.complete("poll:0", { output: polled("needs-review", [], "pending") });
    sc.settle();
    command(sc, { cmd: "verify-stack", reason: "after the review fixes" });
    // What changed since the stack's last push comes first.
    const sinceKey = sc.settle().find((k) => k.startsWith("since:root:"))!;
    sc.complete(sinceKey, { output: { changes: [], removed: [] } });
    const planKey = sc.settle().find((k) => k.startsWith("plan:verify:root:"))!;
    assert.match(planKey, /:ask1$/);
    assert.match(String(sc.plan(planKey).agent?.vars?.goal), /The user asked for this push: “after the review fixes”/);
    sc.complete(planKey, { report: { pushes: [{ purpose: "verify", tryArgs: ["fuzzy", "-q", "x"], rebuild: 5 }], feedback: [] } });
    const dry = sc.settle().find((k) => k.startsWith("dry-run:"))!;
    const push = sc.purpose(dry).push!;
    assert.match(push, /^root-ask1-/);
    sc.complete(dry, { output: { command: ["./mach", "try", "fuzzy"], taskCount: 5, tasks: [], tryTaskConfig: {}, commits: [], warnings: [] } });
    sc.settle();
    assert.ok(sc.open().includes(`approve-push:${push}`), "not withdrawn for being past verification");
    assert.equal(sc.state().step, "review comments");
    // Asked to revise, its planner revises it: that's not declining the ask.
    sc.add({ type: "try-declined", request: ID, push, text: "add mac", replan: true });
    const rev = sc.settle().find((k) => k.startsWith(`${planKey}:revise:`));
    assert.ok(rev, "revised");
    sc.complete(rev!, { report: { pushes: [{ purpose: "verify with mac", tryArgs: ["fuzzy", "-q", "mac"], rebuild: 5 }], answer: "added mac", feedback: [] } });
    const dry2 = sc.settle().find((k) => k.startsWith("dry-run:"))!;
    const v1 = sc.purpose(dry2).push!;
    sc.complete(dry2, { output: { command: ["./mach", "try", "fuzzy"], taskCount: 5, tasks: [], tryTaskConfig: {}, commits: [], warnings: [] } });
    sc.settle();
    assert.ok(sc.open().includes(`approve-push:${v1}`));
    sc.add({ type: "user-done", request: ID, key: `approve-push:${v1}` });
    assert.ok(sc.settle().includes(`push:${v1}`));
    assert.deepEqual(Object.values(sc.state().items).map((i) => i.state), ["waiting for review", "waiting for review"], "its groups stay where their review is");
    sc.add({ type: "try-pushed", request: ID, push: v1, rev: "fed", url: "u" });
    sc.add({ type: "try-finished", request: ID, push: v1, result: "green", summary: "green" });
    sc.settle();
    assert.equal(sc.state().step, "review comments");
    assert.equal(sc.view().jobs.filter((j) => j.purpose.what === "plan-pushes" && j.purpose.key.includes(":ask")).length, 2, "that ask is answered: its plan and its revision");
  });

  it("an author's fix for what a push past verification found broken by it goes to try again once back for review", () => {
    const sc = inReview();
    sc.complete("poll:0", { output: polled("needs-review", [], "pending") });
    sc.settle();
    sc.add({ type: "try-planned", request: ID, push: "root-abcd-1", purpose: "p", command: ["./mach", "try"], taskCount: 1 });
    sc.add({ type: "try-pushed", request: ID, push: "root-abcd-1", rev: "fed", url: "u" });
    sc.add({ type: "try-finished", request: ID, push: "root-abcd-1", result: "failures", summary: "1 failure" });
    const plan = resumeAuthorPlan(ID, sc.view(), "i-test-a", "try", { message: "fix it" }, "investigating");
    assert.ok(plan && plan !== "busy");
    plan.purpose.key = "author:i-test-a:try:root-abcd-1";
    sc.startJob(plan);
    sc.complete(plan.purpose.key, { report: fixed([sha("9")]) });
    sc.settle();
    assert.deepEqual(sc.state().verifyAsked ?? [], [], "not before it's reviewed and back for review");
    assert.equal(landingState(sc.state(), sc.state().patches["p-test-a"]).accepted, false, "it lands once green on try");
    const job = sc.view().byKey.get(plan.purpose.key)![0].job;
    sc.complete(`import:${job}`, { output: imported(sha("9"), "Bug 999 - Fix a, r=smaug.", ["a/test_a.js"], 999).map((c) => ({ ...c, revision: 101 })) });
    for (let i = 0; i < 6; i++) {
      for (const k of sc.settle()) {
        if (k.startsWith("msg:")) sc.complete(k, { output: "m" });
        else if (k.startsWith("lint:")) sc.complete(k, { output: lintOk });
        else if (k.startsWith("review:")) sc.complete(k, { report: ok });
        else if (k.startsWith("rewrite-review:")) sc.complete(k, { output: { mapping: { [sha("9")]: sha("8") } } });
        else if (k.startsWith("interdiff:")) sc.complete(k, { output: { diff: "-a\n+b\n", method: "same-parent" } });
        else if (k.startsWith("test-plan:")) sc.complete(k, { report: { testPlan: "- Ran it.", feedback: [] } });
      }
    }
    assert.equal(sc.state().items["i-test-a"].state, "waiting for review");
    assert.match(sc.state().verifyAsked?.at(-1) ?? "", /^Verify the fix of D101 for what try push fed found broken by it/);
    for (const j of sc.view().jobs.filter((j) => !j.end && j.purpose.key.startsWith("test-plan:"))) sc.complete(j.purpose.key, { report: { testPlan: "- Ran it.", feedback: [] } });
    // A new failure that push found, being investigated, doesn't hold the push up.
    sc.add({ type: "item-created", request: ID, item: "i-test-c", folder: "a", group: { message: "crash", tests: ["a/test_c.js"], configs: [] } });
    sc.add({ type: "item-state", request: ID, item: "i-test-c", state: "investigating" });
    sc.settle();
    const since = sc.view().jobs.find((j) => !j.end && j.purpose.key.startsWith("since:root:"));
    if (since) sc.complete(since.purpose.key, { output: { changes: [], removed: [] } });
    const started = sc.settle();
    const planKey = started.find((k) => k.startsWith("plan:verify:root:"))!;
    assert.ok(planKey, `${String(started)} | open: ${sc.view().jobs.filter((j) => !j.end).map((j) => j.purpose.key)}`);
    assert.match(String(sc.plan(planKey).agent?.vars?.goal), /Verify the fix of D101/);
    const pushOf = (key: string, commits: string[], rev: string) => {
      sc.complete(key, { report: { pushes: [{ purpose: "the failing jobs", tryArgs: ["fuzzy", "-q", "x"], rebuild: 5 }], feedback: [] } });
      const dry = sc.settle().find((k) => k.startsWith("dry-run:"))!;
      const push = sc.purpose(dry).push!;
      sc.complete(dry, { output: { command: ["./mach", "try", "fuzzy"], taskCount: 5, tasks: [], tryTaskConfig: {}, commits, warnings: [] } });
      sc.add({ type: "user-done", request: ID, key: `approve-push:${push}` });
      sc.now += 60_000;
      sc.add({ type: "try-pushed", request: ID, push, rev, url: "u" });
      sc.add({ type: "try-finished", request: ID, push, result: "green", summary: "green" });
      return sc.settle();
    };
    // Green, but without the fix (planned before it was in the stack): asked again.
    const next = pushOf(planKey, [], "abc");
    assert.ok(!sc.state().tryNeeded["p-test-a"].verified);
    assert.match(sc.state().verifyAsked?.at(-1) ?? "", /didn't carry the fix: this one must\.$/);
    for (const k of next.filter((k) => k.startsWith("since:"))) sc.complete(k, { output: { changes: [], removed: [] } });
    const again = [...next, ...sc.settle()].find((k) => k.startsWith("plan:verify:root:") && k !== planKey)!;
    assert.ok(again, String(next));
    // It carries the fix as the stack has it now.
    pushOf(again, [sc.state().patches["p-test-a"].sha], "abd");
    assert.equal(sc.state().tryNeeded["p-test-a"].verified, true);
    assert.equal(landingState(sc.state(), sc.state().patches["p-test-a"]).accepted, sc.state().patches["p-test-a"].review!.reviewers.every((r) => r.status === "accepted"));
  });

  it("a fix made after submission goes on top of the stack once reviewed, for you to submit, without the step going back", () => {
    const sc = inReview();
    sc.complete("poll:0", { output: polled("needs-review", [], "pending") });
    sc.settle();
    sc.add({ type: "item-created", request: ID, item: "i-test-c", folder: "a", group: { message: "crash", tests: ["a/test_c.js"], configs: [] } });
    investigating(sc, "i-test-c");
    reviewed(sc, "i-test-c", sha("3"), "a/test_c.js", { title: "Bug 33 - Fix test_c, r=smaug.", bug: 33 });
    assert.equal(sc.state().step, "review comments");
    const st = sc.state().stacks.root;
    const append = sc.view().jobs.find((j) => j.purpose.key.startsWith("append:root:"))!;
    const args = sc.plan(append.purpose.key).cli!.args;
    assert.equal(args[args.indexOf("--order") + 1], [...st.order.map((pid) => sc.state().patches[pid].sha), sha("3")].join(","));
    assert.ok(args.includes("--edits"), "the submitted patches keep their Differential Revision lines");
    sc.complete(append.purpose.key, { output: { mapping: { [sha("3")]: sha("9") } } });
    sc.settle();
    assert.deepEqual(sc.state().stacks.root.order, [...st.order, "p-test-c"]);
    assert.equal(sc.state().items["i-test-c"].state, "in stack");
    const flag = sc.state().needsUser.find((n) => n.key.startsWith("submit-new:root:"))!;
    assert.equal(flag.action, "Submit 1 new patch");
    assert.equal(sc.view().jobs.filter((j) => j.purpose.key.startsWith("append:")).length, 1, "added once");
    // You submit it: its revision is found, and it waits for review like the others.
    sc.add({ type: "submit-copied", request: ID, stack: "root" });
    sc.settle();
    const imp = sc.view().jobs.find((j) => !j.end && j.purpose.key.startsWith("import-submit:root:"))!.purpose.key;
    sc.complete(imp, {
      output: [
        { ...imported(sha("e"), "Bug 22 - Fix test_b, r=smaug.", [], 22)[0], revision: 100 },
        { ...imported(sha("f"), "Bug 999 - Fix a, r=smaug.", [], 999)[0], revision: 101 },
        { ...imported(sha("9"), "Bug 33 - Fix test_c, r=smaug.", [], 33)[0], revision: 102 },
      ],
    });
    sc.settle();
    assert.equal(sc.state().patches["p-test-c"].revision, 102);
    assert.equal(sc.state().items["i-test-c"].state, "waiting for review");
    assert.ok(!sc.open().some((k) => k.startsWith("submit-new:")));
    assert.equal(sc.state().step, "review comments");
  });

  it("an author told of a push's failure that isn't its own keeps its submitted patch waiting for review", () => {
    const sc = inReview();
    const plan = resumeAuthorPlan(ID, sc.view(), "i-test-a", "try", { message: "Try push fed found these failures" }, "investigating");
    assert.ok(plan && plan !== "busy");
    plan.purpose.key = "author:i-test-a:try:x";
    sc.startJob(plan);
    sc.complete(plan.purpose.key, { report: { ...fixed([sha("f")]), state: "left as-is", summary: "that failure isn't from this patch" } });
    assert.equal(sc.state().items["i-test-a"].state, "waiting for review");
  });

  it("a message to an author whose worktree was removed waits for it to be restored", () => {
    const sc = inReview();
    const name = `${ID}-i-test-a`;
    sc.startJob({ purpose: { key: `remove:${name}`, what: "remove" }, kind: "script", name: "worktree.ts remove", cwd: config.firefoxRepo, cli: { tool: "worktree.ts", args: ["remove", name] } });
    sc.complete(`remove:${name}`, { output: { name, removed: true } });
    command(sc, { cmd: "continue", item: "i-test-a", text: "Post the reply." });
    const queued = sc.state().queuedAuthors![0].key;
    assert.ok(!sc.view().byKey.has(queued), "not resumed in a missing worktree");
    const restore = sc.settle().find((k) => k.startsWith(`wt-restore:${name}:`))!;
    assert.deepEqual(sc.plan(restore).cli?.args, ["create", name, "--build", "artifact"], "on its kept branch: no --base");
    sc.complete(restore, { output: { name, path: `/wt/${name}` } });
    assert.ok(sc.settle().includes(queued));
    assert.match(sc.plan(queued).agent?.message ?? "", /Post the reply\./);
  });

  it("an answer that changes no code asks only to post its replies; comments from anyone but you count", () => {
    const sc = inReview();
    sc.complete("poll:0", { output: polled("needs-revision", [{ id: 7, author: "emilio", text: "Why not CheckForAnchorChange?", done: false, length: 0 }, { id: 8, author: "florian", text: "my note", done: false, length: 0 }], "blocking").map((x) => ({ ...x, author: "florian" })) });
    const classify = sc.settle().find((k) => k.startsWith("classify-comments:p-test-a:"));
    assert.ok(classify, "emilio isn't a listed reviewer, but his question is answered");
    assert.ok(!sc.view().jobs.some((j) => j.purpose.key.startsWith("classify-comments:p-test-b:")));
    const p = sc.state().patches["p-test-a"];
    // Submitted from an earlier commit of it.
    const past = p.pastShas![0];
    sc.add({ type: "needs-user", request: ID, key: "resubmit:root:jx", action: "Post 1 reply, then resubmit D101", detail: "", stack: "root", patch: "p-test-a" });
    sc.add({ type: "review-status", request: ID, patch: "p-test-a", ...p.review!, diff: { id: 1, commit: past, created: "2026-01-01T00:00:00.000Z" } });
    const inter = sc.settle().find((k) => k.startsWith("interdiff:p-test-a:phab-"))!;
    sc.complete(inter, { output: { diff: "", method: "same-parent" } });
    sc.settle();
    assert.ok(!sc.open().includes("resubmit:root:jx"));
    assert.equal(sc.state().needsUser.find((n) => n.key === "reply:resubmit:root:jx")?.action, "Post 1 reply on D101");
  });

  it("a waiting patch that differs from what Phabricator has asks to be resubmitted, flag or not", () => {
    const sc = inReview();
    const past = sc.state().patches["p-test-a"].pastShas![0];
    sc.complete("poll:0", { output: polled("needs-review", [], "pending").map((x) => ({ ...x, diff: { id: 9, commit: past, created: "2026-01-01T00:00:00.000Z" } })) });
    const inter = sc.settle().find((k) => k.startsWith("interdiff:p-test-a:phab-"))!;
    sc.complete(inter, { output: { diff: "-a\n+b\n", method: "same-parent" } });
    sc.settle();
    const flag = sc.state().needsUser.find((n) => n.patch === "p-test-a" && n.key.startsWith("resubmit:"))!;
    assert.equal(flag.action, "Resubmit D101");
    // Dismissed: a later diff on Phabricator (another patch resubmitted) doesn't bring the same change back.
    sc.now += 60_000;
    sc.add({ type: "user-done", request: ID, key: flag.key });
    const p = sc.state().patches["p-test-a"];
    sc.add({ type: "review-status", request: ID, patch: "p-test-a", ...p.review!, diff: { id: 10, commit: past, created: "2026-01-01T00:00:00.000Z" } });
    sc.settle();
    assert.ok(!sc.state().needsUser.some((n) => n.patch === "p-test-a" && n.key.startsWith("resubmit:")), "not asked again");
  });

  it("a diff submitted from a commit this repository doesn't have is compared with what the factory sent", () => {
    const sc = inReview();
    const sent = sc.state().patches["p-test-a"].sentSha!;
    sc.complete("poll:0", { output: polled("needs-review", [], "pending").map((x) => ({ ...x, diff: { id: 9, commit: "75fcba685a34f24f98e8cad94c4ea933680747f6", created: "2026-01-01T00:00:00.000Z" } })) });
    const inter = sc.settle().find((k) => k.startsWith("interdiff:p-test-a:phab-"));
    if (inter) assert.equal(sc.plan(inter).cli!.args.at(-2), sent);
  });

  it("a comment on a fix shows its author its draft replies, which its answer may rewrite", () => {
    const sc = inReview();
    sc.complete("poll:0", { output: polled("needs-revision", [{ id: 7, author: "emilio", text: "Why not CheckForAnchorChange?", done: false, length: 0 }], "blocking") });
    sc.add({ type: "reply-draft", request: ID, patch: "p-test-a", commentId: 7, text: "Menus don't follow their anchor." });
    command(sc, { cmd: "comment-fix", patch: "p-test-a", text: "emilio means using CheckForAnchorChange for menus too" });
    const key = sc.view().jobs.findLast((j) => j.purpose.key.includes(":comment:"))!.purpose.key;
    assert.match(sc.plan(key).agent?.message ?? "", /Your draft replies to the reviewers, not posted yet:\n- comment 7 \(emilio: “Why not CheckForAnchorChange\?”\): Menus don't follow their anchor\./);
    sc.complete(key, { report: { ...fixed([sha("f")]), replies: [{ commentId: 7, text: "Done: menus now go through CheckForAnchorChange." }] } });
    assert.deepEqual(sc.state().patches["p-test-a"].replyDrafts, [{ commentId: 7, text: "Done: menus now go through CheckForAnchorChange." }]);
  });

  it("redo-step back before review is refused once the stack is on Phabricator", () => {
    const sc = inReview();
    command(sc, { cmd: "redo-step", step: "verify on try", reason: "another push" });
    assert.equal(sc.state().step, "review comments");
    assert.match(JSON.stringify(sc.events.at(-1)), /doesn't go back to verify on try/);
  });
});

describe("9. review comments", () => {
  it("keeps checking Phabricator while the stack is back on try", () => {
    const sc = inReview();
    sc.complete("poll:0", { output: polled("needs-review") });
    sc.add({ type: "step", request: ID, step: "verify on try" });
    sc.now += 4 * 3_600_000;
    assert.ok(sc.settle().includes("poll:1"));
  });

  it("looks for the revisions you submitted while the stack is still being reworked", () => {
    const sc = stacked();
    // A group being reworked: the stack isn't ready for this version, which never stopped you submitting.
    sc.add({ type: "item-state", request: ID, item: "i-test-a", state: "investigating" });
    sc.add({ type: "submit-copied", request: ID, stack: "root" });
    assert.ok(sc.settle().some((k) => k.startsWith("import-submit:root:")));
  });

  it("keeps a plan already written up to date before the stack is verified (a split copies plans)", () => {
    const sc = stacked();
    assert.ok(!sc.view().jobs.some((j) => j.purpose.key.startsWith("test-plan:p-test-a:")), "none written before verification");
    sc.add({ type: "test-plan", request: ID, patch: "p-test-a", text: "- an old plan" });
    sc.showTestPlans = true;
    assert.ok(sc.settle().some((k) => k.startsWith("test-plan:p-test-a:")));
  });

  it("gives a test plan only the pushes that had its patch, saying whether they had this version of it", () => {
    const sc = stacked();
    const planKey = sc.view().jobs.find((j) => j.purpose.what === "plan-pushes")!.purpose.key;
    sc.complete(planKey, { report: { pushes: [{ purpose: "verify", tryArgs: ["fuzzy", "-q", "x"], rebuild: 5 }], feedback: [] } });
    const [dry] = sc.settle();
    const push = sc.purpose(dry).push!;
    // Only test_a's patch, as it was then, went to try.
    sc.complete(dry, { output: { command: ["./mach", "try", "fuzzy"], taskCount: 5, tasks: [], tryTaskConfig: {}, commits: [sha("d")], warnings: [] } });
    sc.add({ type: "user-done", request: ID, key: `approve-push:${push}` });
    sc.add({ type: "try-pushed", request: ID, push, rev: "fed", url: "u" });
    sc.add({ type: "try-finished", request: ID, push, result: "green", summary: "green" });
    sc.settle();
    sc.complete(`try-table:${push}:final`, { output: table() });
    sc.settle();
    const { deps: _d, review: _r, replyDrafts: _rd, id, ...a } = sc.state().patches["p-test-a"];
    sc.add({ type: "patch", request: ID, patch: id, ...a, sha: sha("7") });
    sc.settle();
    const pushesOf = (pid: string) => JSON.parse(sc.plan(sc.view().jobs.findLast((j) => j.purpose.key.startsWith(`test-plan:${pid}:`))!.purpose.key).files![1].content);
    assert.deepEqual(pushesOf("p-test-a").map((x: { rev: string; thisVersion: boolean }) => [x.rev, x.thisVersion]), [["fed", false]]);
    assert.deepEqual(pushesOf("p-test-a")[0].runs, [{ test: "a/test_a.js", configs: [{ jobName: "test-linux2404-64/opt-mochitest-plain-1", jobs: 1, passed: 1, passedOnRetry: 0, failed: 0 }] }], "where its test ran, read by the factory");
    assert.deepEqual(pushesOf("p-test-b"), [], "that push didn't have test_b's patch");
  });

  it("writes each accepted patch's test plan, which you set on its revision with a click", () => {
    const sc = inReview();
    const key = sc.view().jobs.find((j) => !j.end && j.purpose.key.startsWith("test-plan:p-test-a:"))!.purpose.key;
    const plan = sc.plan(key);
    assert.equal(plan.name, "write-test-plan");
    assert.equal(plan.agent?.vars?.firefoxRepo, config.firefoxRepo);
    assert.deepEqual(plan.files?.map((f) => f.path.split("/").pop()), ["test-plan-p-test-a-investigation.json", "test-plan-p-test-a-pushes.json"]);
    assert.throws(() => sc.complete(key, { report: { testPlan: "- Reproduced locally.\n- No try push has run this version; Windows is untested.\n", feedback: [] } }), /“No try push has run this version; Windows is untested”: a test plan says what was run/);
    assert.throws(() => sc.complete(key, { report: { testPlan: "- Reproduced locally. Debug builds were not tried.\n", feedback: [] } }), /“not tried\.?”|a test plan says what was run/);
    assert.throws(() => sc.complete(key, { report: { testPlan: "- Green on try; macOS was not in that push.\n", feedback: [] } }), /a test plan says what was run/);
    sc.complete(key, { report: { testPlan: "- Reproduced by widening the race: 6/6 failures, 0/20 with the fix.\n- Green on try.\n", feedback: [] } });
    assert.equal(sc.state().patches["p-test-a"].testPlan, "- Reproduced by widening the race: 6/6 failures, 0/20 with the fix.\n- Green on try.");
    assert.ok(!sc.settle().some((k) => k.startsWith("test-plan:p-test-a:")), "written once for the same investigation and try results");

    const command = { v: 1, id: "c-plan", t: "2026-10-15T09:00:00.000Z", request: ID, cmd: "set-test-plan", patch: "p-test-a", text: "  Edited plan.\n" } as Command;
    const effects = commandEffects(command, { config, state: sc.state(), view: sc.view(), exists: () => false, plan: (j) => sc.plans.get(j) });
    const start = effects.find((e) => e.type === "start")!;
    assert.ok(start.type === "start");
    assert.deepEqual(start.plan.cli?.args.slice(0, 2), ["set-test-plan", "D101"]);
    assert.equal(start.plan.files?.[0].content, "Edited plan.\n");
    sc.startJob(start.plan);
    sc.complete("set-test-plan:p-test-a:c-plan", { output: { revision: 101, testPlan: "Edited plan." } });
    assert.deepEqual(sc.state().patches["p-test-a"].testPlanSent && { ...sc.state().patches["p-test-a"].testPlanSent, t: "" }, { revision: 101, text: "Edited plan.", t: "" });

    const refused = commandEffects({ ...command, id: "c-plan-2", patch: "p-nope" } as Command, { config, state: sc.state(), view: sc.view(), exists: () => false, plan: () => undefined });
    assert.ok(refused.some((e) => e.type === "event" && e.event.type === "command-executed" && !e.event.ok));

    // Revised by the agent that wrote it, in its session.
    const revise = commandEffects({ ...command, id: "c-rev", cmd: "revise-test-plan", text: "Name the platform." } as Command, { config, state: sc.state(), view: sc.view(), exists: () => false, plan: (j) => sc.plans.get(j) });
    const again = revise.find((e) => e.type === "start");
    assert.ok(again?.type === "start");
    assert.equal(again.plan.agent?.resume, true);
    assert.equal(again.plan.agent?.sessionId, sc.view().jobs.find((j) => j.purpose.key === key)!.sessionId);
    assert.match(again.plan.agent?.message ?? "", /Name the platform\./);
    sc.startJob(again.plan);
    sc.complete(again.plan.purpose.key, { report: { testPlan: "- Locally on Ubuntu 24.04 (debug): 6/6, 0/20 with the fix.", feedback: [] } });
    assert.equal(sc.state().patches["p-test-a"].testPlan, "- Locally on Ubuntu 24.04 (debug): 6/6, 0/20 with the fix.");
  });

  it("polls Phabricator every 2 min for 10 after you copied moz-phab, then every 10 min while you're present, every 3 h while you're away", () => {
    const sc = inReview();
    assert.deepEqual(sc.view().jobs.filter((j) => !j.end && !j.purpose.key.startsWith("test-plan:")).map((j) => j.purpose.key), ["poll:0"]);
    assert.deepEqual(sc.plan("poll:0").cli?.args, ["poll", "D100", "D101"]);
    assert.equal(sc.plan("poll:0").priority, 0);
    const pending = () => polled("needs-review", [], "pending");
    sc.complete("poll:0", { output: pending() });
    assert.equal(sc.state().patches["p-test-a"].review?.status, "needs-review");
    // You just copied moz-phab submit (inReview): every 2 minutes.
    sc.now += 2 * 60_000;
    assert.deepEqual(sc.settle(), ["poll:1"]);
    sc.complete("poll:1", { output: pending() });
    sc.now += 10 * 60_000;
    assert.deepEqual(sc.settle(), ["poll:2"]);
    sc.complete("poll:2", { output: pending() });
    // Then every 10 minutes.
    sc.now += 9 * 60_000;
    assert.deepEqual(sc.settle(), []);
    sc.now += 60_000;
    assert.deepEqual(sc.settle(), ["poll:3"]);
    sc.complete("poll:3", { output: pending() });
    sc.present = false;
    sc.now += 2 * HOUR;
    assert.deepEqual(sc.settle(), []);
    sc.now += HOUR;
    assert.deepEqual(sc.settle(), ["poll:4"]);
    sc.complete("poll:4", { output: pending() });
    // Back at the page: the 10 min rule again.
    sc.present = true;
    sc.presentSince = sc.now;
    sc.now += 10 * 60_000;
    assert.deepEqual(sc.settle(), ["poll:5"]);
  });

  it("polls right away when you ask, even while you're away, once per request", () => {
    const sc = inReview();
    sc.complete("poll:0", { output: polled("needs-review", [], "pending") });
    sc.present = false;
    sc.now += 60_000;
    assert.deepEqual(sc.settle(), []);
    sc.add({ type: "poll-requested", request: ID });
    assert.equal(sc.state().pollRequested, new Date(sc.now - 1000).toISOString());
    assert.deepEqual(sc.settle(), ["poll:1"]);
    // Asked again while it runs: once more after it, then not again.
    sc.add({ type: "poll-requested", request: ID });
    assert.deepEqual(sc.settle(), []);
    sc.complete("poll:1", { output: polled("needs-review", [], "pending") });
    assert.deepEqual(sc.settle(), ["poll:2"]);
    sc.complete("poll:2", { output: polled("needs-review", [], "pending") });
    sc.now += 60_000;
    assert.deepEqual(sc.settle(), []);
  });

  it("a push its author asks for once its patch is on Phabricator waits for its change to be reviewed, then goes with the whole stack", () => {
    const sc = inReview();
    sc.complete("poll:0", { output: polled("needs-review", [], "pending") });
    sc.settle();
    const plan = resumeAuthorPlan(ID, sc.view(), "i-test-a", "continue", { message: "push it" }, "investigating");
    assert.ok(plan && plan !== "busy");
    plan.purpose.key = "author:i-test-a:continue:c-9";
    sc.startJob(plan);
    sc.complete("author:i-test-a:continue:c-9", { report: fixed([sha("9")], { tryRequest: "test_a.js on linux debug" }) });
    const started = sc.settle();
    assert.ok(!started.some((k) => k.startsWith("plan:asked:")), String(started));
    assert.ok(started.some((k) => k.startsWith("import:")), String(started));
    assert.deepEqual(sc.state().verifyAsked ?? [], [], "not before its change is reviewed and in the stack");
  });

  it("classifies new comments, the author addresses them first, then the stack is rewritten and you resubmit", () => {
    const sc = inReview();
    const comment = { id: 7, author: "smaug", file: "a/test_a.js", line: 3, length: 1, text: "Use waitForCondition", done: false };
    const mine = { id: 8, author: "florian", text: "ok", done: false, replyTo: 7, length: 1 };
    sc.complete("poll:0", { output: polled("needs-revision", [comment, mine], "blocking") });
    const [classify] = sc.settle();
    assert.match(classify, /^classify-comments:p-test-a:/);
    assert.equal(sc.plan(classify).priority, 0);
    sc.complete(classify, { report: { comments: [{ id: 7, kind: "change request", impliesChange: true }], feedback: [] } });
    assert.equal(sc.state().patches["p-test-a"].review?.comments[0].kind, "change request");
    const [address] = sc.settle();
    const plan = sc.plan(address);
    assert.equal(plan.name, "address-review");
    assert.equal(plan.agent?.resume, true);
    assert.equal(plan.agent?.sessionId, sc.plan("author:i-test-a:initial").agent?.sessionId);
    assert.equal(plan.priority, 0);
    assert.deepEqual(plan.purpose.comments, [7]);
    assert.deepEqual(JSON.parse(plan.files![0].content).map((c: { id: number }) => c.id), [7]);
    assert.equal(sc.state().items["i-test-a"].state, "addressing review comments");

    // A sha it made up (its git log cut off) goes back to it, whatever author it is.
    sc.commitExists = (_cwd, c) => c === sha("7");
    assert.throws(() => sc.complete(address, { report: { state: "addressed", summary: "s", commits: ["f1e9d2a8c47b"], replies: [], feedback: [] } }), (e: Error) => e instanceof InvalidReport && e.message.startsWith("f1e9d2a8c47b isn't a commit in "));
    const job = sc.complete(address, { report: { state: "addressed", summary: "s", commits: [sha("7")], replies: [{ commentId: 7, text: "waitForCondition hides the race." }], feedback: [] } });
    assert.deepEqual(sc.state().patches["p-test-a"].replyDrafts, [{ commentId: 7, text: "waitForCondition hides the race." }]);
    sc.settle();
    assert.equal(sc.plan(`import:${job}`).priority, 0);
    sc.complete(`import:${job}`, { output: imported(sha("7"), "Bug 999 - Fix a, r=smaug.", ["a/test_a.js"], 999).map((c) => ({ ...c, revision: 101 })) });
    sc.settle();
    sc.complete(`msg:p-test-a:${sha("7")}`, { output: "m" });
    sc.complete(`lint-reply:${job}:7`, { output: lintOk });
    sc.settle();
    sc.complete(`lint:p-test-a:${sha("7")}`, { output: lintOk });
    sc.settle();
    assert.equal(sc.plan(`review:p-test-a:${job}`).priority, 0);
    // Reviewed against the comments it answers.
    const reviewPlan = sc.plan(`review:p-test-a:${job}`);
    assert.match(String(reviewPlan.agent?.vars?.comments ?? ""), /It answers the review comments in .*: check each one is really dealt with/);
    assert.deepEqual(JSON.parse(reviewPlan.files![0].content).map((c: { id: number }) => c.id), [7]);
    sc.complete(`review:p-test-a:${job}`, { report: ok });
    // Copying the moz-phab command since doesn't change what the reviewer saw.
    sc.now += 60_000;
    sc.add({ type: "submit-copied", request: ID, stack: "root" });
    assert.deepEqual(sc.settle(), [`rewrite-review:root:${job}:v2`]);
    // Its commit lost its Differential Revision line: the rewrite gives every submitted patch its own back.
    const rw = sc.plan(`rewrite-review:root:${job}:v2`);
    assert.deepEqual(rw.cli?.args.slice(-5), ["--order", `${sha("e")},${sha("7")}`, "--leave-conflict", "--edits", rw.files![0].path]);
    assert.deepEqual(JSON.parse(rw.files![0].content), {
      [sha("e")]: { revision: "https://phabricator.services.mozilla.com/D100" },
      [sha("7")]: { revision: "https://phabricator.services.mozilla.com/D101" },
    });
    sc.complete(`rewrite-review:root:${job}:v2`, { output: { mapping: { [sha("e")]: sha("e"), [sha("7")]: sha("8") } } });
    // Against what Phabricator has (the commit D101 showed up on), not the author's previous commit.
    const key = `interdiff:p-test-a:${job}:${sha("f").slice(0, 12)}`;
    assert.deepEqual(sc.settle(), [key]);
    assert.deepEqual(sc.plan(key).cli?.args, ["interdiff", "--cwd", `/wt/${ID}-root`, sha("f"), sha("8")]);
    const inter = sc.complete(key, { output: { diff: "-a\n+b\n", method: "same-parent" } });
    assert.equal(sc.state().patches["p-test-a"].interdiffFile, `requests/${ID}/data/interdiff-p-test-a-${inter}.diff`);
    sc.settle();
    const n = sc.state().needsUser.find((x) => x.key.startsWith("resubmit:"))!;
    assert.equal(n.action, "Post 1 reply, then resubmit D101");
    assert.equal(n.stack, "root");
    assert.equal(sc.state().items["i-test-a"].state, "waiting for review");
    // It stays until Phabricator has a newer diff, however many polls go by.
    const pollWith = (created: string) => {
      sc.now += 11 * 60_000;
      const key = sc.settle().find((k) => k.startsWith("poll:"))!;
      sc.complete(key, { output: polled("needs-review", [], "pending").map((x) => ({ ...x, diff: { id: 1, commit: sha("f"), created } })) });
      sc.settle();
    };
    pollWith("2026-10-01T00:00:00.000Z");
    assert.ok(sc.open().includes(n.key), "an older diff: not resubmitted yet");
    const phabInter = `interdiff:p-test-a:phab-${sha("f").slice(0, 12)}:${sha("8").slice(0, 12)}`;
    assert.ok(sc.view().byKey.has(phabInter), "what a resubmit sends, against what Phabricator has");
    sc.complete(phabInter, { output: { diff: "-a\n+b\n", method: "same-parent" } });
    sc.settle();
    assert.ok(sc.open().includes(n.key), "a change to send");
    pollWith(new Date(sc.now).toISOString());
    assert.ok(!sc.open().includes(n.key), "resubmitted");
  });

it("an addressed commit that conflicts on today's central goes to resolve-conflict, then gets its Differential Revision line back", () => {
    const sc = inReview();
    const comment = { id: 7, author: "smaug", file: "a/test_a.js", line: 3, length: 1, text: "Use waitForCondition", done: false };
    const mine = { id: 8, author: "florian", text: "ok", done: false, replyTo: 7, length: 1 };
    sc.complete("poll:0", { output: polled("needs-revision", [comment, mine], "blocking") });
    const [classify] = sc.settle();
    assert.match(classify, /^classify-comments:p-test-a:/);
    assert.equal(sc.plan(classify).priority, 0);
    sc.complete(classify, { report: { comments: [{ id: 7, kind: "change request", impliesChange: true }], feedback: [] } });
    assert.equal(sc.state().patches["p-test-a"].review?.comments[0].kind, "change request");
    const [address] = sc.settle();
    const plan = sc.plan(address);
    assert.equal(plan.name, "address-review");
    assert.equal(plan.agent?.resume, true);
    assert.equal(plan.agent?.sessionId, sc.plan("author:i-test-a:initial").agent?.sessionId);
    assert.equal(plan.priority, 0);
    assert.deepEqual(plan.purpose.comments, [7]);
    assert.deepEqual(JSON.parse(plan.files![0].content).map((c: { id: number }) => c.id), [7]);
    assert.equal(sc.state().items["i-test-a"].state, "addressing review comments");

    // A sha it made up (its git log cut off) goes back to it, whatever author it is.
    sc.commitExists = (_cwd, c) => c === sha("7");
    assert.throws(() => sc.complete(address, { report: { state: "addressed", summary: "s", commits: ["f1e9d2a8c47b"], replies: [], feedback: [] } }), (e: Error) => e instanceof InvalidReport && e.message.startsWith("f1e9d2a8c47b isn't a commit in "));
    const job = sc.complete(address, { report: { state: "addressed", summary: "s", commits: [sha("7")], replies: [{ commentId: 7, text: "waitForCondition hides the race." }], feedback: [] } });
    assert.deepEqual(sc.state().patches["p-test-a"].replyDrafts, [{ commentId: 7, text: "waitForCondition hides the race." }]);
    sc.settle();
    assert.equal(sc.plan(`import:${job}`).priority, 0);
    sc.complete(`import:${job}`, { output: imported(sha("7"), "Bug 999 - Fix a, r=smaug.", ["a/test_a.js"], 999).map((c) => ({ ...c, revision: 101 })) });
    sc.settle();
    sc.complete(`msg:p-test-a:${sha("7")}`, { output: "m" });
    sc.complete(`lint-reply:${job}:7`, { output: lintOk });
    sc.settle();
    sc.complete(`lint:p-test-a:${sha("7")}`, { output: lintOk });
    sc.settle();
    assert.equal(sc.plan(`review:p-test-a:${job}`).priority, 0);
    sc.complete(`review:p-test-a:${job}`, { report: ok });
    assert.deepEqual(sc.settle(), [`rewrite-review:root:${job}:v2`]);
    // Its commit lost its Differential Revision line: the rewrite gives every submitted patch its own back.
    const rw = sc.plan(`rewrite-review:root:${job}:v2`);
    assert.deepEqual(rw.cli?.args.slice(-5), ["--order", `${sha("e")},${sha("7")}`, "--leave-conflict", "--edits", rw.files![0].path]);
    assert.deepEqual(JSON.parse(rw.files![0].content), {
      [sha("e")]: { revision: "https://phabricator.services.mozilla.com/D100" },
      [sha("7")]: { revision: "https://phabricator.services.mozilla.com/D101" },
    });
    sc.complete(`rewrite-review:root:${job}:v2`, { output: { mapping: { [sha("e")]: sha("e") }, conflict: { sha: sha("7"), files: ["a/browser.toml"] } } });
    const [resolve] = sc.settle();
    assert.equal(resolve, `resolve:root:review-${job}:${sha("7")}`);
    sc.complete(resolve, { report: { state: "resolved", commit: sha("c"), explanation: "kept both entries", feedback: [] } });
    assert.equal(sc.state().patches["p-test-a"].sha, sha("c"));
    const [again] = sc.settle();
    assert.equal(again, `rewrite-review:root:${job}:v2:resolved`);
    assert.deepEqual(Object.keys(JSON.parse(sc.plan(again).files![0].content)), [sha("e"), sha("c")]);
  });

  it("a nits pass after the answer still leads to the resubmit, with the answer's replies", () => {
    const sc = inReview();
    sc.complete("poll:0", { output: polled("needs-revision", [{ id: 7, author: "smaug", text: "Use waitForCondition", done: false, length: 1 }], "blocking") });
    const [classify] = sc.settle();
    sc.complete(classify, { report: { comments: [{ id: 7, kind: "change request", impliesChange: true }], feedback: [] } });
    const [address] = sc.settle();
    const job = sc.complete(address, { report: { state: "addressed", summary: "s", commits: [sha("7")], replies: [{ commentId: 7, text: "Done." }], feedback: [] } });
    sc.settle();
    sc.complete(`import:${job}`, { output: imported(sha("7"), "Bug 999 - Fix a, r=smaug.", ["a/test_a.js"], 999).map((c) => ({ ...c, revision: 101 })) });
    sc.settle();
    sc.complete(`msg:p-test-a:${sha("7")}`, { output: "m" });
    sc.complete(`lint-reply:${job}:7`, { output: lintOk });
    sc.settle();
    sc.complete(`lint:p-test-a:${sha("7")}`, { output: lintOk });
    sc.settle();
    sc.complete(`review:p-test-a:${job}`, { report: { verdict: "findings", findings: [{ severity: "nit", text: "wordy" }], feedback: [] } });
    const nits = `author:i-test-a:nits:${job}`;
    assert.deepEqual(sc.settle(), [nits]);
    assert.ok(
      sc.plan(nits).agent?.message?.startsWith("Your patch is on Phabricator as D101 (https://phabricator.services.mozilla.com/D101): read its reviews with the read-phabricator-comments skill."),
      "its own D number, not its stack neighbor's",
    );
    const pass = sc.complete(nits, { report: fixed([sha("9")]) });
    sc.settle();
    sc.complete(`import:${pass}`, { output: imported(sha("9"), "Bug 999 - Fix a, r=smaug.", ["a/test_a.js"], 999).map((c) => ({ ...c, revision: 101 })) });
    sc.settle();
    sc.complete(`msg:p-test-a:${sha("9")}`, { output: "m" });
    sc.settle();
    sc.complete(`lint:p-test-a:${sha("9")}`, { output: lintOk });
    assert.deepEqual(sc.settle(), [`rewrite-review:root:${pass}:v2`]);
  });
});

describe("9. changes after submission", () => {
  // Its author runs for reason with a new commit, imported, linted and reviewed; started before or after the submission.
  function changed(reason: string, before = false): { sc: Scenario; job: string } {
    let sc: Scenario;
    const key = `author:i-test-a:${reason.replace(/\s+/g, "-")}:c-1`;
    const start = () => {
      const plan = resumeAuthorPlan(ID, sc.view(), "i-test-a", reason, { message: "m" }, "investigating");
      assert.ok(plan && plan !== "busy");
      plan.purpose.key = key;
      sc.startJob(plan);
    };
    if (before) {
      sc = submitting();
      sc.complete("reviewers:root", { output: { files: [], suggestions: [] } });
      const [check] = sc.settle();
      sc.complete(check, { output: { ok: true, failures: [] } });
      sc.add({ type: "submit-copied", request: ID, stack: "root" });
      sc.settle();
      // While you submit.
      start();
      sc.complete("import-submit:root:0", {
        output: [
          { ...imported(sha("e"), "Bug 22 - Fix test_b, r=smaug.", [], 22)[0], revision: 100 },
          { ...imported(sha("f"), "Bug 999 - Fix a, r=smaug.", [], 999)[0], revision: 101 },
        ],
      });
      sc.settle();
    } else {
      sc = inReview();
      start();
    }
    sc.complete("poll:0", { output: polled("needs-review", [], "pending") });
    const job = sc.complete(key, { report: fixed([sha("7")]) });
    sc.settle();
    sc.complete(`import:${job}`, { output: imported(sha("7"), "Bug 999 - Fix a, r=smaug.", ["a/test_a.js"], 999).map((c) => ({ ...c, revision: 101 })) });
    sc.settle();
    sc.complete(`msg:p-test-a:${sha("7")}`, { output: "m" });
    sc.settle();
    sc.complete(`lint:p-test-a:${sha("7")}`, { output: lintOk });
    sc.settle();
    sc.complete(`review:p-test-a:${job}`, { report: ok });
    return { sc, job };
  }

  for (const reason of ["continue", "comment", "stack comments", "asked push", "try"]) {
    it(`an author run for ${reason} after the submission is put in the stack, and asks you to resubmit`, () => {
      const { sc, job } = changed(reason);
      assert.deepEqual(sc.settle(), [`rewrite-review:root:${job}:v2`]);
      const rw = sc.plan(`rewrite-review:root:${job}:v2`);
      assert.deepEqual(JSON.parse(rw.files![0].content)[sha("7")], { revision: "https://phabricator.services.mozilla.com/D101" });
      sc.complete(`rewrite-review:root:${job}:v2`, { output: { mapping: { [sha("e")]: sha("e"), [sha("7")]: sha("8") } } });
      const [inter] = sc.settle();
      assert.equal(inter, `interdiff:p-test-a:${job}:${sha("f").slice(0, 12)}`);
      assert.deepEqual(sc.plan(inter).cli?.args.slice(-2), [sha("f"), sha("8")]);
      sc.complete(inter, { output: { diff: "-a\n+b\n", method: "same-parent" } });
      sc.settle();
      const n = sc.state().needsUser.find((x) => x.key.startsWith("resubmit:"))!;
      assert.equal(n.action, "Resubmit D101");
      assert.equal(n.detail, "changed by its author since you submitted it and re-reviewed (Opus) · interdiff below");
      assert.equal(sc.state().items["i-test-a"].state, "waiting for review");
      // Dismissed (it lands as it is): not asked again.
      sc.add({ type: "user-done", request: ID, key: n.key });
      sc.settle();
      assert.ok(!sc.open().some((k) => k.startsWith("resubmit:")));
    });
  }

  it("once Phabricator has the resubmitted commit, the next change's interdiff is against it", () => {
    const { sc, job } = changed("continue");
    sc.settle();
    sc.complete(`rewrite-review:root:${job}:v2`, { output: { mapping: { [sha("e")]: sha("e"), [sha("7")]: sha("8") } } });
    sc.settle();
    sc.complete(`interdiff:p-test-a:${job}:${sha("f").slice(0, 12)}`, { output: { diff: "-a\n+b\n", method: "same-parent" } });
    sc.settle();
    sc.add({ type: "submit-copied", request: ID, stack: "root" });
    assert.equal(sc.state().patches["p-test-a"].sentSha, sha("8"));
    // Its next poll shows the diff moz-phab made from it.
    const review = sc.state().patches["p-test-a"].review!;
    sc.add({ type: "review-status", request: ID, patch: "p-test-a", ...review, diff: { id: 2, commit: sha("8"), created: new Date(sc.now).toISOString() } });
    sc.settle();
    // Its author changes it again.
    const plan = resumeAuthorPlan(ID, sc.view(), "i-test-a", "continue", { message: "m" }, "investigating");
    assert.ok(plan && plan !== "busy");
    plan.purpose.key = "author:i-test-a:continue:c-2";
    sc.startJob(plan);
    const again = sc.complete(plan.purpose.key, { report: fixed([sha("9")]) });
    sc.settle();
    sc.complete(`import:${again}`, { output: imported(sha("9"), "Bug 999 - Fix a, r=smaug.", ["a/test_a.js"], 999).map((c) => ({ ...c, revision: 101 })) });
    sc.settle();
    sc.complete(`msg:p-test-a:${sha("9")}`, { output: "m" });
    sc.settle();
    sc.complete(`lint:p-test-a:${sha("9")}`, { output: lintOk });
    sc.settle();
    sc.complete(`review:p-test-a:${again}`, { report: ok });
    assert.deepEqual(sc.settle(), [`rewrite-review:root:${again}:v2`]);
    sc.complete(`rewrite-review:root:${again}:v2`, { output: { mapping: { [sha("e")]: sha("e"), [sha("9")]: sha("a") } } });
    const inter = `interdiff:p-test-a:${again}:${sha("8").slice(0, 12)}`;
    assert.deepEqual(sc.settle(), [inter]);
    assert.deepEqual(sc.plan(inter).cli?.args.slice(-2), [sha("8"), sha("a")]);
  });

  it("an author run that started before the submission is neither rewritten nor resubmitted", () => {
    const { sc } = changed("continue", true);
    assert.ok(!sc.settle().some((k) => k.startsWith("rewrite-review:")));
    assert.ok(!sc.open().some((k) => k.startsWith("resubmit:")));
    assert.equal(sc.state().items["i-test-a"].state, "reviewed");
  });
});

describe("10. landing", () => {
  it("moves accepted patches to the bottom and asks you to land; done once everything has landed", () => {
    const sc = inReview();
    // Only D101 (p-test-a) accepted: D100 still waits for review.
    const [d100, d101] = polled("accepted");
    sc.complete("poll:0", { output: [{ ...d100, status: "needs-review", reviewers: [{ name: "smaug", status: "pending" }] }, d101] });
    sc.settle();
    assert.equal(sc.state().step, "landing");
    assert.deepEqual(sc.state().stacks.root.order, ["p-test-b", "p-test-a"]);
    const key = sc.view().jobs.find((j) => j.purpose.key.startsWith("order-landable:"))!.purpose.key;
    sc.complete(key, { output: { order: ["p-test-a", "p-test-b"], flippedSoftDeps: [{ patch: "p-test-b", needs: "p-test-a", kind: "soft", reason: "shares a helper", source: "agent" }], landable: ["p-test-a"] } });
    const [rewrite] = sc.settle();
    assert.match(rewrite, /^rewrite-land:root:/);
    assert.deepEqual(JSON.parse(sc.plan(rewrite).files![0].content), { [sha("e")]: { revision: "https://phabricator.services.mozilla.com/D100" }, [sha("f")]: { revision: "https://phabricator.services.mozilla.com/D101" } });
    sc.complete(rewrite, { output: { mapping: { [sha("f")]: sha("5"), [sha("e")]: sha("6") } } });
    const [adapt] = sc.settle();
    assert.equal(sc.plan(adapt).name, "adapt-soft-dep");
    assert.deepEqual(sc.plan(adapt).agent?.vars, { patchA: sha("6"), patchB: sha("5"), reason: "shares a helper" });
    sc.complete(adapt, { report: { state: "adapted", commits: [sha("5"), sha("4")], summary: "s", feedback: [] } });
    const [refresh] = sc.settle();
    sc.complete(refresh, { output: [{ ...imported(sha("5"), "Bug 999 - Fix a, r=smaug.", [], 999)[0], revision: 101 }, { ...imported(sha("4"), "Bug 22 - Fix test_b, r=smaug.", [], 22)[0], revision: 100 }] });
    sc.settle();
    const flag = sc.state().needsUser.find((n) => n.key.startsWith("land:root:"))!;
    assert.match(flag.key, /^land:root:[0-9a-f]{10}$/, "keyed by the stack's order");
    assert.equal(flag.action, "Stack reordered: 1 landable patch moved to the bottom");
    assert.equal(flag.detail, "Run moz-phab reorg so Phabricator has the new order (1 soft dependency adapted).");
    assert.equal(flag.stack, "root");

    sc.now += 3 * HOUR;
    sc.settle();
    sc.complete("poll:1", { output: polled("published") });
    sc.settle();
    const s = sc.state();
    assert.equal(s.step, "done");
    assert.equal(s.items["i-test-a"].state, "landed");
    // Worktrees go, removed from the main checkout, never from inside themselves.
    const removes = sc.view().jobs.filter((j) => j.purpose.what === "remove");
    assert.deepEqual(removes.map((j) => j.purpose.key).sort(), [`remove:${ID}-i-test-a`, `remove:${ID}-i-test-b`].sort(), "the stack's stays while its landings are watched");
    assert.ok(removes.every((j) => j.cwd === config.firefoxRepo));
    sc.now += 4 * 24 * 3_600_000;
    assert.ok(sc.settle().includes(`remove:${ID}-root`), "then goes");
  });
});

describe("10. landing: the reorg flag", () => {
  const accepted = () => {
    const sc = inReview();
    sc.complete("poll:0", { output: polled("accepted") });
    sc.settle();
    return { sc, key: sc.view().jobs.find((j) => j.purpose.key.startsWith("order-landable:"))!.purpose.key };
  };

  it("asks for nothing when the landable patches are already at the bottom, and clears an earlier reorg flag", () => {
    const { sc, key } = accepted();
    sc.add({ type: "needs-user", request: ID, key: "land:root:old", action: "Stack reordered", detail: "", stack: "root" });
    sc.complete(key, { output: { order: sc.state().stacks.root.order, flippedSoftDeps: [], landable: ["p-test-b"] } });
    assert.deepEqual(sc.settle(), []);
    assert.ok(!sc.view().jobs.some((j) => j.purpose.key.startsWith("rewrite-land:")));
    assert.deepEqual(sc.open().filter((k) => k.startsWith("land:")), []);
  });

  it("says nothing about soft dependencies when none was adapted, and stays answered once you copied the reorg", () => {
    const { sc, key } = accepted();
    const order = [...sc.state().stacks.root.order].reverse();
    sc.complete(key, { output: { order, flippedSoftDeps: [], landable: [order[0]] } });
    const [rewrite] = sc.settle();
    sc.complete(rewrite, { output: { mapping: { [sha("f")]: sha("5"), [sha("e")]: sha("6") } } });
    sc.settle();
    const flag = sc.state().needsUser.find((n) => n.key.startsWith("land:root:"))!;
    assert.equal(flag.action, "Stack reordered: 1 landable patch moved to the bottom");
    assert.equal(flag.detail, "Run moz-phab reorg so Phabricator has the new order.");
    sc.add({ type: "user-done", request: ID, key: flag.key });
    sc.settle();
    assert.deepEqual(sc.open().filter((k) => k.startsWith("land:")), [], "not raised again");
  });

  it("keeps the order you submitted (moz-phab or reorg) across stack events", () => {
    const { sc, key } = accepted();
    assert.deepEqual(sc.state().stacks.root.submittedOrder, ["p-test-b", "p-test-a"]);
    sc.complete(key, { output: { order: ["p-test-a", "p-test-b"], flippedSoftDeps: [], landable: ["p-test-a"] } });
    const [rewrite] = sc.settle();
    sc.complete(rewrite, { output: { mapping: { [sha("f")]: sha("5"), [sha("e")]: sha("6") } } });
    sc.settle();
    assert.deepEqual(sc.state().stacks.root.order, ["p-test-a", "p-test-b"]);
    assert.deepEqual(sc.state().stacks.root.submittedOrder, ["p-test-b", "p-test-a"], "kept on a stack event");
    const flag = sc.state().needsUser.find((n) => n.key.startsWith("land:root:"))!;
    sc.add({ type: "user-done", request: ID, key: flag.key, reorg: true });
    assert.deepEqual(sc.state().stacks.root.submittedOrder, ["p-test-a", "p-test-b"], "copying the reorg gives Phabricator the new order");
    // Another stack event keeps it.
    const { id, ...rest } = sc.state().stacks.root;
    sc.add({ type: "stack", request: ID, stack: id, ...rest, order: ["p-test-b", "p-test-a"] });
    assert.deepEqual(sc.state().stacks.root.submittedOrder, ["p-test-a", "p-test-b"]);
    sc.add({ type: "submit-copied", request: ID, stack: "root" });
    assert.deepEqual(sc.state().stacks.root.submittedOrder, ["p-test-b", "p-test-a"], "copying moz-phab submit records the order");
  });

  it("once every patch is landable, the stack goes back to its ranked order, the one you submitted, and the reorg is moot", () => {
    const sc = inReview();
    const [d100, d101] = polled("accepted");
    sc.complete("poll:0", { output: [{ ...d100, status: "needs-review", reviewers: [{ name: "smaug", status: "pending" }] }, d101] });
    sc.settle();
    const key = sc.view().jobs.find((j) => j.purpose.key.startsWith("order-landable:"))!.purpose.key;
    sc.complete(key, { output: { order: ["p-test-a", "p-test-b"], flippedSoftDeps: [], landable: ["p-test-a"] } });
    const [rewrite] = sc.settle();
    sc.complete(rewrite, { output: { mapping: { [sha("f")]: sha("5"), [sha("e")]: sha("6") } } });
    sc.settle();
    assert.ok(sc.open().some((k) => k.startsWith("land:root:")));
    // D100 gets accepted too: landable patches keep their ranked order among themselves.
    sc.now += 10 * 60_000;
    sc.settle();
    sc.complete("poll:1", { output: polled("accepted") });
    sc.settle();
    const again = sc.view().jobs.find((j) => j.purpose.key.startsWith("order-landable:") && j.purpose.key !== key)!.purpose.key;
    sc.complete(again, { output: { order: ["p-test-b", "p-test-a"], flippedSoftDeps: [], landable: ["p-test-b", "p-test-a"] } });
    const [back] = sc.settle();
    assert.equal(back, `rewrite-land:root:${again.split(":").at(-1)}:v2`);
    const args = sc.plan(back).cli!.args;
    assert.equal(args[args.indexOf("--order") + 1], [sha("6"), sha("5")].join(","));
    sc.complete(back, { output: { mapping: { [sha("6")]: sha("7"), [sha("5")]: sha("8") } } });
    sc.settle();
    assert.deepEqual(sc.state().stacks.root.order, ["p-test-b", "p-test-a"]);
    assert.deepEqual(sc.settle(), []);
    assert.deepEqual(sc.open().filter((k) => k.startsWith("land:")), [], "Phabricator has that order already");
  });

  it("asks for no reorg when the landing reorder gives back the order you submitted", () => {
    const { sc, key } = accepted();
    const { id, ...rest } = sc.state().stacks.root;
    sc.add({ type: "stack", request: ID, stack: id, ...rest, order: ["p-test-a", "p-test-b"] });
    sc.complete(key, { output: { order: ["p-test-b", "p-test-a"], flippedSoftDeps: [], landable: ["p-test-b"] } });
    const [rewrite] = sc.settle();
    assert.match(rewrite, /^rewrite-land:root:/);
    sc.complete(rewrite, { output: { mapping: {} } });
    sc.settle();
    assert.deepEqual(sc.state().stacks.root.order, ["p-test-b", "p-test-a"]);
    assert.deepEqual(sc.open().filter((k) => k.startsWith("land:")), []);
  });
});

describe("burndown stack", () => {
  it("is one stack for the request's folder, its subfolders' groups included", () => {
    const sc = new Scenario("burndown", { folder: "a" });
    sc.step();
    sc.settle();
    sc.complete("wt:signal", { output: { name: `${ID}-signal`, path: `/wt/${ID}-signal`, branch: `${ID}-signal` } });
    sc.settle();
    sc.complete("annotations", { output: [] });
    sc.settle();
    sc.complete("collect:folder:folder", { output: [failure("a/test_a.js", "boom"), failure("a/sub/test_b.js", "bang")] });
    sc.settle();
    sc.complete("cluster:folder:folder", { output: { groups: [group("ka", "a/test_a.js", "boom"), group("kb", "a/sub/test_b.js", "bang")], singles: [] } });
    sc.settle();
    const merge = sc.view().jobs.find((j) => j.purpose.key.startsWith("merge:") && !j.end)?.purpose.key;
    if (merge) {
      sc.complete(merge, { report: { groups: [group("ka", "a/test_a.js", "boom"), group("kb", "a/sub/test_b.js", "bang")].map((g) => ({ message: g.message, tests: g.tests, configs: g.configs, from: [g.key], reason: "unchanged" })), feedback: [] } });
      sc.settle();
    }
    investigating(sc, "i-test-a");
    investigating(sc, "i-test-b");
    reviewed(sc, "i-test-a", sha("1"), "a/test_a.js");
    reviewed(sc, "i-test-b", sha("2"), "a/sub/test_b.js");
    assert.deepEqual(sc.view().jobs.filter((j) => j.purpose.key.startsWith("wt:a")).map((j) => j.purpose.key), ["wt:a"]);
    sc.complete("wt:a", { output: { name: `${ID}-a`, path: `/wt/${ID}-a`, branch: `${ID}-a` } });
    const [assemble] = sc.settle();
    assert.deepEqual(sc.plan(assemble).cli?.args.slice(-2), [sha("1"), sha("2")]);
  });
});

// Completes the running write-meta-bug agent, as the burndown's meta bug draft.
function metaDrafted(sc: Scenario, description = "Reviewers: patch by patch."): string {
  const key = sc.view().jobs.find((j) => !j.end && j.purpose.what === "meta-draft")!.purpose.key;
  sc.complete(key, { report: { description, feedback: [] } });
  sc.settle();
  return key;
}

describe("burndown verification", () => {
  // A burndown whose stack was verified on try with the DEBUG commit on top, waiting for its meta bug.
  const verified = (check = false, bug: number | null = null, result: "green" | "failures" = "green", conflict = false) => {
    const sc = new Scenario("burndown", { folder: "a" });
    sc.step();
    sc.settle();
    sc.complete("wt:signal", { output: { name: `${ID}-signal`, path: `/wt/${ID}-signal`, branch: `${ID}-signal` } });
    sc.settle();
    sc.complete("annotations", { output: [{ manifest: "a/xpcshell.toml", test: "test_a.js", kind: "skip-if", condition: "os == 'win'", line: 2, commit: null, bug: null, commentBugs: [] }] });
    sc.settle();
    sc.complete("classify:0", { report: { kind: "flakiness", reason: "intermittent", feedback: [] } });
    sc.settle();
    // Only a DEBUG commit: nothing to review, the annotations item is done.
    sc.complete("author:i-annotations:initial", { report: { debug: sha("9"), summary: "un-skip", feedback: [] } });
    sc.settle();
    sc.complete("plan:unskip", { report: { pushes: [{ purpose: "reproduce", tryArgs: ["fuzzy", "-q", "xpcshell"], rebuild: 10 }], feedback: [] } });
    sc.settle();
    sc.complete("dry-run:unskip", { output: { command: ["./mach", "try", "fuzzy"], taskCount: 4, tasks: [], tryTaskConfig: {}, commits: [sha("9")], warnings: [] } });
    sc.add({ type: "user-done", request: ID, key: "approve-push:unskip" });
    sc.settle();
    sc.complete("push:unskip", { output: { rev: "def", landoJobId: 1, treeherderUrl: "t" } });
    sc.settle();
    assert.equal(sc.state().step, "work list");
    sc.complete("watch:unskip", { output: "" });
    sc.add({ type: "try-finished", request: ID, push: "unskip", result: "failures", summary: "s" });
    sc.settle();
    sc.complete("try-table:unskip:final", { output: table() });
    sc.complete("collect:unskip:final", { output: [failure("a/test_a.js", "boom")] });
    sc.settle();
    sc.complete("cluster:unskip:final", { output: { groups: [group("ka", "a/test_a.js", "boom")], singles: [] } });
    investigating(sc, "i-test-a");
    reviewed(sc, "i-test-a", sha("1"), "a/test_a.js", bug ? { title: `Bug ${bug} - Fix a/test_a.js, r=smaug.`, bug } : {});
    sc.complete("wt:a", { output: { name: `${ID}-a`, path: `/wt/${ID}-a`, branch: `${ID}-a` } });
    sc.settle();
    const hash = sc.view().jobs.find((j) => j.purpose.what === "assemble")!.purpose.key.split(":")[2];
    sc.complete(`assemble:a:${hash}`, { output: { commits: [{ sha: sha("1"), newSha: sha("a") }] } });
    sc.settle();
    sc.complete(`deps:a:${hash}`, { output: [] });
    sc.complete(`effort:p-test-a:${sha("1")}`, { report: { effort: 1, reason: "r", feedback: [] } });
    sc.settle();
    sc.complete(keyOf(sc, `order:a:${hash}:`), { output: { order: ["p-test-a"], flippedSoftDeps: [] } });
    sc.settle();
    sc.complete(keyOf(sc, `review-stack:a:${hash}:`), { report: { findings: [], addDeps: [], removeDeps: [], feedback: [] } });
    sc.settle();
    sc.complete(`summary:a:${hash}`, { output: { markdown: "t", metaComment: "m" } });
    const started = sc.settle();
    const sync = started.find((k) => k.startsWith("sync:"))!;
    const tryBranch = started.find((k) => k.startsWith("try-branch:"))!;
    assert.equal(sc.state().step, "verify on try");
    metaDrafted(sc);
    if (check) assert.match(sync, /^sync:a:/, "its reviewers are right before you may submit");
    reviewersChecked(sc);
    sc.complete("reviewers:a", { output: { files: [], suggestions: [] } });

    // The stack branch plus the DEBUG commit, on a branch of its own: that's what try gets.
    if (check) assert.match(tryBranch, /^try-branch:a:[0-9a-f]{6}$/);
    const args = sc.plan(tryBranch).cli!.args;
    if (check) assert.deepEqual([args[0], args[4], ...args.slice(5)], ["assemble", `${ID}-a-try-${tryBranch.split(":")[2]}`, "--base", `${ID}-a`, "--leave-conflict", sha("9")]);
    if (conflict) {
      // The DEBUG commit conflicts with the stack's fix: resolve-conflict's commit is what goes to try.
      sc.complete(tryBranch, { output: { branch: args[4], head: sha("a"), commits: [], conflict: { sha: sha("9"), files: ["a/xpcshell.toml"] }, remaining: [] } });
      const [resolve] = sc.settle();
      sc.complete(resolve, { report: { state: "resolved", commit: sha("b"), explanation: "kept the fix's line", feedback: [] } });
    } else sc.complete(tryBranch, { output: { branch: args[4], head: sha("b"), commits: [{ sha: sha("9"), newSha: sha("b") }] } });
    const [planKey] = sc.settle();
    if (check) assert.equal(sc.plan(planKey).agent?.vars?.branch, args[4]);
    if (check) assert.equal(sc.state().patches["p-test-a"].sha, sha("a"));
    sc.complete(planKey, { report: { pushes: [{ purpose: "verify", tryArgs: ["fuzzy", "-q", "x"], rebuild: 5 }], feedback: [] } });
    const [dry] = sc.settle();
    const push = sc.purpose(dry).push!;
    sc.complete(dry, { output: { command: ["./mach", "try", "fuzzy"], taskCount: 5, tasks: [], tryTaskConfig: {}, commits: [sha("b"), sha("a")], warnings: [] } });
    sc.add({ type: "user-done", request: ID, key: `approve-push:${push}` });
    sc.add({ type: "try-pushed", request: ID, push, rev: "fed", url: "u" });
    sc.add({ type: "try-finished", request: ID, push, result, summary: result });
    sc.settle();
    sc.complete(`try-table:${push}:final`, { output: table() });
    sc.settle();
    if (check) assert.equal(sc.state().step, "meta bug");
    return { sc, push };
  };

  it("pushes the stack with the DEBUG commit on top, then checks the stack branch out again before submitting", () => {
    const { sc } = verified(true);
    // No skip to remove for real (followed with one in the next test).
    sc.complete("author:i-annotations:removal", { report: { summary: "every test still fails", feedback: [] } });
    sc.settle();
    // You file test_a's drafted bug, then the meta bug.
    const { deps: _d, review: _r, replyDrafts: _rd, id, ...p } = sc.state().patches["p-test-a"];
    sc.add({ type: "patch", request: ID, patch: id, ...p, bug: 555, bugFromYou: true });
    sc.add({ type: "meta-bug", request: ID, bug: 999 });
    const [rewrite] = sc.settle();
    sc.complete(rewrite, { output: { mapping: { [sha("a")]: sha("c") } } });
    sc.settle();

    // Before submitting, the stack's own branch, without the DEBUG commit, is checked out again.
    assert.equal(sc.state().step, "submit");
    assert.deepEqual(sc.view().jobs.filter((j) => !j.end && !j.purpose.key.startsWith("sync:") && !j.purpose.key.startsWith("test-plan:")).map((j) => j.purpose.key), ["checkout:a"]);
    const checkout = sc.plan("checkout:a");
    assert.deepEqual([checkout.cli, checkout.cwd], [{ tool: "git", args: ["checkout", `${ID}-a`] }, `/wt/${ID}-a`]);
    sc.complete("checkout:a", { output: "" });
    reviewersChecked(sc);
    assert.ok(sc.view().jobs.some((j) => !j.end && j.purpose.key.startsWith("check:a:")));
  });
  it("a DEBUG commit that conflicted on top of the stack: the removal starts from resolve-conflict's commit", () => {
    const { sc } = verified(false, null, "green", true);
    assert.match(sc.plan("author:i-annotations:removal").agent!.message!, new RegExp(`On top of the stack it became ${sha("b").slice(0, 12)} \\(branch ${ID}-a-try-`));
  });
  it("then has the skip-ifs' author replace the DEBUG commit and write the removal, a patch that needs the meta bug", () => {
    // Its own patch has a bug: nothing needs the meta bug until the removal.
    const { sc } = verified(false, 22);
    assert.equal(sc.state().step, "meta bug", "waits for the removal before going on");
    const key = "author:i-annotations:removal";
    const open = () => sc.view().jobs.filter((j) => !j.end && !j.purpose.key.startsWith("test-plan:")).map((j) => j.purpose.key);
    assert.deepEqual(open(), [key]);
    const message = sc.plan(key).agent!.message!;
    assert.match(message, /DEBUG commit on top: fed \(green\)\. On top of the stack it became/);
    assert.match(message, /Bug XXXXXXX - Remove skip-if annotations that no longer fail in a/);
    sc.complete(key, { report: { removal: sha("7"), summary: "removed one skip", feedback: [] } });
    sc.settle();
    // The removal is a patch: imported and linted.
    const author = sc.view().byKey.get(key)![0].job;
    sc.complete(`import:${author}`, { output: imported(sha("7"), "Bug XXXXXXX - Remove skip-if annotations that no longer fail in a, r=smaug.", ["a/xpcshell.toml"]) });
    sc.settle();
    assert.equal(sc.state().patches["p-annotations"].sha, sha("7"));
    sc.complete(`msg:p-annotations:${sha("7")}`, { output: "Bug XXXXXXX - Remove\n\nBody.\n" });
    sc.settle();
    sc.complete(`lint:p-annotations:${sha("7")}`, { output: lintOk });
    if (sc.view().byKey.has(`lint-bug:${author}`)) sc.complete(`lint-bug:${author}`, { output: lintOk });
    sc.settle();
    // The commit try verified, only reworded: no critical review.
    assert.ok(!sc.view().byKey.has(`review:p-annotations:${author}`));
    assert.equal(sc.state().items["i-annotations"].state, "reviewed");
    assert.equal(sc.state().step, "meta bug");

    // It goes in the stack, last.
    const [assemble] = open();
    assert.match(assemble, /^assemble:a:/);
    const hash = assemble.split(":")[2];
    assert.deepEqual(sc.plan(assemble).cli?.args.slice(-2), ["--order", `${sha("1")},${sha("7")}`]);
    sc.complete(assemble, { output: { mapping: { [sha("1")]: sha("a"), [sha("7")]: sha("d") } } });
    sc.settle();
    sc.complete(`deps:a:${hash}`, { output: [] });
    sc.settle();
    sc.complete(keyOf(sc, `order:a:${hash}:`), { output: { order: ["p-test-a", "p-annotations"], flippedSoftDeps: [] } });
    sc.settle();
    sc.complete(keyOf(sc, `review-stack:a:${hash}:`), { report: { findings: [], addDeps: [], removeDeps: [], feedback: [] } });
    sc.settle();
    const drafts = () => sc.view().jobs.filter((j) => j.purpose.what === "meta-draft").map((j) => j.purpose.key);
    assert.equal(drafts().length, 1, "not written again before the stack is ready");
    assert.ok(!sc.open().includes("meta-bug:a"));
    sc.complete(`summary:a:${hash}`, { output: { markdown: "t", metaComment: "m" } });
    sc.settle();
    // Written again for the stack with its removal.
    assert.equal(drafts().length, 2);
    const stackFile = JSON.parse(String(sc.plan(drafts()[1]).files![0].content));
    assert.deepEqual(stackFile.map((p: { bug: unknown }) => p.bug), [22, "the meta bug"]);
    metaDrafted(sc, "Now with the removal.");
    assert.equal(sc.state().metaBug?.draft?.description, "Now with the removal.");

    // That patch has no bug: the stack now needs the meta bug.
    const s = sc.state();
    assert.deepEqual(s.stacks.a.order, ["p-test-a", "p-annotations"]);
    assert.ok(needsMetaBug(s.stacks.a.order.map((pid) => s.patches[pid])));
    assert.equal(s.metaBug?.bug, null);
    assert.ok(s.needsUser.some((n) => n.key === "meta-bug:a"));
    assert.equal(s.step, "meta bug");
    assert.equal(sc.view().jobs.filter((j) => j.purpose.reason === "removal").length, 1, "not resumed again");
    sc.add({ type: "meta-bug", request: ID, bug: 999 });
    const [rewrite] = sc.settle();
    assert.match(rewrite, /^rewrite-bugs:a:/);
    assert.deepEqual(sc.purpose(rewrite).edits, { "p-annotations": 999 });
    assert.equal(sc.view().jobs.filter((j) => j.purpose.reason === "removal").length, 1, "not resumed again");
  });
  // Changes a patch, as an import would.
  const setPatch = (sc: Scenario, pid: string, fields: object) => {
    const { deps: _d, review: _r, replyDrafts: _rd, id, ...p } = sc.state().patches[pid];
    sc.add({ type: "patch", request: ID, patch: id, ...p, ...fields });
    sc.settle();
  };
  // The removal written, imported and assembled last in the stack, which is ready again.
  const withRemoval = (sc: Scenario) => {
    const key = "author:i-annotations:removal";
    sc.complete(key, { report: { removal: sha("7"), summary: "removed one skip", feedback: [] } });
    sc.settle();
    const author = sc.view().byKey.get(key)![0].job;
    sc.complete(`import:${author}`, { output: imported(sha("7"), "Bug XXXXXXX - Remove skip-if annotations that no longer fail in a, r=smaug.", ["a/xpcshell.toml"]) });
    sc.settle();
    sc.complete(`msg:p-annotations:${sha("7")}`, { output: "Bug XXXXXXX - Remove\n\nBody.\n" });
    sc.settle();
    sc.complete(`lint:p-annotations:${sha("7")}`, { output: lintOk });
    if (sc.view().byKey.has(`lint-bug:${author}`)) sc.complete(`lint-bug:${author}`, { output: lintOk });
    sc.settle();
    const assemble = sc.view().jobs.find((j) => !j.end && j.purpose.what === "assemble")!.purpose.key;
    const hash = assemble.split(":")[2];
    sc.complete(assemble, { output: { mapping: { [sha("1")]: sha("a"), [sha("7")]: sha("d") } } });
    sc.settle();
    sc.complete(`deps:a:${hash}`, { output: [] });
    sc.settle();
    sc.complete(keyOf(sc, `order:a:${hash}:`), { output: { order: ["p-test-a", "p-annotations"], flippedSoftDeps: [] } });
    sc.settle();
    sc.complete(keyOf(sc, `review-stack:a:${hash}:`), { report: { findings: [], addDeps: [], removeDeps: [], feedback: [] } });
    sc.settle();
    sc.complete(`summary:a:${hash}`, { output: { markdown: "t", metaComment: "m" } });
    sc.settle();
  };

  it("ranks the skip-if removal before every fix: its effort is 0, without an estimate", () => {
    const { sc } = verified(false, 22);
    withRemoval(sc);
    assert.ok(!sc.view().jobs.some((j) => j.purpose.key.startsWith("effort:p-annotations:")));
    assert.equal(sc.state().patches["p-annotations"].effort, 0);
    const input = JSON.parse(sc.plan(keyOf(sc, "order:a:")).files![0].content);
    assert.equal(input.patches.find((p: { id: string }) => p.id === "p-annotations").effort, 0);
  });
  const draftKeys = (sc: Scenario) => sc.view().jobs.filter((j) => j.purpose.what === "meta-draft").map((j) => j.purpose.key);

  it("the meta bug's draft: a task blocking the configured bugs, its text by an agent, written again when a patch's bug changes", () => {
    const blocks = config.metaBugBlocks;
    config.metaBugBlocks = [2063593];
    try {
      const { sc } = verified(false, 22);
      const [first] = draftKeys(sc);
      assert.match(first, /^meta-draft:a:/);
      const draft = sc.state().metaBug!.draft!;
      assert.deepEqual(
        [draft.summary, draft.bugType, draft.keywords, draft.blocks, draft.description],
        ["[meta] Fix the flakiness in a", "task", ["meta"], [2063593], "Reviewers: patch by patch."],
      );
      assert.equal(sc.state().metaBug!.bug, null);
      const plan = sc.plan(first);
      assert.equal(plan.agent?.vars?.stackFile, plan.files![0].path);
      assert.equal(JSON.parse(plan.files![0].content)[0].bug, 22);

      // No skip to remove: the stack is the same, ready again.
      sc.complete("author:i-annotations:removal", { report: { summary: "every test still fails", feedback: [] } });
      sc.settle();
      assert.deepEqual(draftKeys(sc), [first]);
      setPatch(sc, "p-test-a", { bug: 23, title: "Bug 23 - Fix a/test_a.js, r=smaug." });
      const keys = draftKeys(sc);
      assert.equal(keys.length, 2);
      assert.notEqual(keys[1], first);
      assert.equal(JSON.parse(sc.plan(keys[1]).files![0].content)[0].bug, 23);
    } finally {
      config.metaBugBlocks = blocks;
    }
  });

  it("no blocks without metaBugBlocks", () => {
    const { sc } = verified(false, 22);
    assert.equal(sc.state().metaBug!.draft!.blocks, undefined);
  });

  it("a draft that arrives after the meta bug is filed leaves it as it is", () => {
    const { sc } = verified(false, 22);
    sc.complete("author:i-annotations:removal", { report: { summary: "every test still fails", feedback: [] } });
    sc.settle();
    setPatch(sc, "p-test-a", { bug: 23, title: "Bug 23 - Fix a/test_a.js, r=smaug." });
    const draft = sc.state().metaBug!.draft;
    sc.add({ type: "meta-bug", request: ID, bug: 999, draft });
    metaDrafted(sc, "Too late.");
    assert.equal(sc.state().metaBug!.bug, 999);
    assert.equal(sc.state().metaBug!.draft!.description, "Reviewers: patch by patch.");
    setPatch(sc, "p-test-a", { bug: 24, title: "Bug 24 - Fix a/test_a.js, r=smaug." });
    assert.equal(draftKeys(sc).length, 2, "not written again once filed");
  });

  it("the meta bug is filed last: its ⚑ waits for the stack's other bugs to be filed", () => {
    const { sc } = verified(false, 22);
    setPatch(sc, "p-test-a", { bug: null, title: "Bug XXXXXXX - Fix a/test_a.js, r=smaug.", bugDraft: { product: "Core", component: "XPCOM", summary: "s", description: "d" } });
    withRemoval(sc);
    metaDrafted(sc);
    const s = sc.state();
    assert.deepEqual(s.stacks.a.order, ["p-test-a", "p-annotations"]);
    assert.ok(needsMetaBug(s.stacks.a.order.map((pid) => s.patches[pid])));
    assert.ok(s.metaBug?.draft);
    assert.deepEqual(sc.open().filter((k) => k.startsWith("meta-bug:") || k.startsWith("file-bug:")), ["file-bug:p-test-a:meta-bug-step"]);
    setPatch(sc, "p-test-a", { bug: 555, title: "Bug 555 - Fix a/test_a.js, r=smaug." });
    assert.ok(sc.open().includes("meta-bug:a"));
    assert.ok(!sc.open().some((k) => k.startsWith("file-bug:")));
  });

  it("all green, has the author cherry-pick the commit try ran on top of the stack and only reword it", () => {
    const { sc } = verified(false, 22);
    const message = sc.plan("author:i-annotations:removal").agent!.message!;
    assert.match(message, new RegExp(`git cherry-pick ${sha("b")}`));
    assert.match(message, new RegExp(`it became ${sha("b").slice(0, 12)} \\(branch ${ID}-a-try-`));
    assert.match(message, /Change no code/);
    assert.doesNotMatch(message, /tryRequest|fx-tests|Drop the DEBUG commit/);
  });
  it("with failures, has the author cherry-pick the same commit and list the skips whose tests still fail", () => {
    const { sc } = verified(false, 22, "failures");
    // No failure of its result table is the stack's: it passes, and the request moves on.
    assert.equal(sc.state().step, "meta bug");
    sc.settle();
    const message = sc.plan("author:i-annotations:removal").agent!.message!;
    assert.match(message, /DEBUG commit on top: fed \(failures\)/);
    assert.match(message, new RegExp(`git rebase --onto ${sha("9")}\\^ ${sha("9")} && git cherry-pick ${sha("b")}`));
    assert.match(message, /Change no code/);
    assert.match(message, /fx-tests try <rev>/);
    assert.match(message, /`keepSkips`[^]*report without `removal`/);
  });

  // The removal's author listed a skip whose test still fails: you decide.
  const asking = () => {
    const { sc } = verified(false, 22, "failures");
    sc.add({ type: "step", request: ID, step: "meta bug" });
    sc.settle();
    const keepSkips = [{ skip: "a/xpcshell.toml test_a.js os == 'win'", failure: "boom on fed" }];
    const job = sc.complete("author:i-annotations:removal", { report: { summary: "one still fails", keepSkips, feedback: [] } });
    sc.settle();
    return { sc, job };
  };
  const runCommand = (sc: Scenario, c: Record<string, unknown>) => {
    const command = { v: 1, id: "c-keep", t: "2026-10-15T09:00:00.000Z", request: ID, ...c } as Command;
    for (const e of commandEffects(command, { config, state: sc.state(), view: sc.view(), exists: () => false, plan: (j) => sc.plans.get(j) })) {
      if (e.type === "event") sc.add(e.event);
      if (e.type === "start") sc.startJob(e.plan);
    }
  };

  it("a skip whose test still fails blocks the removal on your answer, and the meta bug waits", () => {
    const { sc, job } = asking();
    const s = sc.state();
    assert.equal(s.items["i-annotations"].state, "blocked");
    const flag = s.needsUser.find((n) => n.key === `keep-skips:${job}`);
    assert.ok(flag);
    assert.equal(flag.action, "Keep this skip-if? Their tests still fail on try");
    assert.equal(flag.detail, "a/xpcshell.toml test_a.js os == 'win': boom on fed");
    assert.equal(flag.item, "i-annotations");
    assert.equal(s.step, "meta bug");
    assert.ok(!s.needsUser.some((n) => n.key.startsWith("meta-bug:")), "the meta bug waits");
    assert.deepEqual(sc.view().jobs.filter((j) => !j.end && !j.purpose.key.startsWith("sync:") && !j.purpose.key.startsWith("test-plan:")).map((j) => j.purpose.key), []);
  });

  it("Keep them resumes its author, whose removal becomes the patch, and the question goes away", () => {
    const { sc, job } = asking();
    runCommand(sc, { cmd: "continue", item: "i-annotations", text: "Yes, keep them." });
    sc.settle();
    const key = "author:i-annotations:continue:c-keep";
    assert.match(sc.plan(key).agent!.message!, /Yes, keep them\./);
    sc.complete(key, { report: { removal: sha("7"), summary: "kept the failing skip", feedback: [] } });
    sc.settle();
    assert.equal(sc.state().items["i-annotations"].state, "fix verified locally");
    assert.ok(!sc.state().needsUser.some((n) => n.key.startsWith("keep-skips:")), `${job}'s question is answered`);
    const author = sc.view().byKey.get(key)![0].job;
    sc.complete(`import:${author}`, { output: imported(sha("7"), "Bug XXXXXXX - Remove skip-if annotations that no longer fail in a, r=smaug.", ["a/xpcshell.toml"]) });
    sc.settle();
    assert.equal(sc.state().patches["p-annotations"].sha, sha("7"));
    assert.equal(sc.state().step, "meta bug");
    assert.ok(!sc.state().needsUser.some((n) => n.key.startsWith("meta-bug:")), "waits for the removal in the stack");
  });
});

describe("redo-step", () => {
  it("on an item, starts it over with new keys", () => {
    const sc = workList([group("ka", "a/test_a.js", "boom")]);
    investigating(sc, "i-test-a");
    sc.complete("author:i-test-a:initial", { report: { ...fixed([]), state: "left as-is" } });
    sc.add({ type: "item-state", request: ID, item: "i-test-a", state: "not started", detail: "try again" });
    assert.deepEqual(sc.settle(), ["prior-art:i-test-a@1"]);
  });

  it("on the work list, runs it again", () => {
    const sc = workList([group("ka", "a/test_a.js", "boom")]);
    sc.add({ type: "step", request: ID, step: "work list" });
    assert.deepEqual(sc.step().sort(), ["collect:initial:final@1", "try-table:initial:final@1"]);
  });

  it("on the request, plans the step again", () => {
    const sc = stacked();
    const planKey = sc.view().jobs.find((j) => j.purpose.what === "plan-pushes")!.purpose.key;
    sc.complete(planKey, { report: { pushes: [], feedback: [] } });
    sc.settle();
    sc.add({ type: "step", request: ID, step: "verify on try" });
    assert.deepEqual(sc.settle(), [`${planKey}@1`]);
  });
});
