// One test per step transition of docs/MVP.md, plus the rules of docs/ORCHESTRATOR.md.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InvalidReport } from "./handlers.ts";
import { resumeAuthorPlan, similarMessages, stackId } from "./next.ts";
import { config, HOUR, ID, Scenario, sha } from "./testkit.ts";
import { shortHash } from "./plan.ts";

const none = { verdict: "none", quote: "no bug", feedback: [] };
const ok = { verdict: "ok", findings: [], feedback: [] };
const lintOk = { ok: true, violations: [] };
const fixed = (commits: string[], extra = {}) => ({ state: "fix verified locally", summary: "fixed", cause: "c", verification: "v", commits, landsAfter: [], feedback: [], ...extra });
const imported = (s: string, title: string, files: string[], bug: number | null = null) => [{ sha: s, title, bug, reviewers: [], files, insertions: 1, deletions: 0, testOnly: true }];
const table = (rows: unknown[] = [], unparsed: unknown[] = []) => ({ rev: "abc", pushId: 1, project: "try", complete: true, pending: 0, configs: [], rows, unparsed });
const failure = (test: string, message: string) => ({ test, config: "linux/opt-xpcshell", message, taskIds: ["T1"], count: 1 });
const group = (key: string, test: string, message: string, rate = 1) => ({ key, message, tests: [test], configs: ["linux/opt-xpcshell"], ratePerWeek: rate, taskIds: ["T1"] });

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
  sc.complete(`author:${item}:initial`, { report: fixed([commit], opts.report) });
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
    assert.deepEqual(sc.view().jobs.filter((j) => !j.end).map((j) => j.purpose.key), ["wt:signal"]);
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
    assert.deepEqual(sc.plan("dry-run:unskip").cli?.args, ["dry-run", "--cwd", `/wt/${ID}-signal`, "--pending", `/state/requests/${ID}/data/pending-unskip.json`, "--", "fuzzy", "-q", "xpcshell"]);
    sc.complete("dry-run:unskip", { output: { command: ["./mach", "try", "fuzzy", "-q", "xpcshell"], taskCount: 40, tasks: [], tryTaskConfig: {}, commits: ["c2", "c1"], warnings: ["artifact push"] } });
    sc.settle();
    assert.deepEqual(sc.open(), ["approve-push:unskip"]);
    assert.equal(sc.state().needsUser[0].detail, "40 tasks · reproduce · artifact push");
    assert.equal(sc.state().step, "first signal");

    // Approved: pushed, watched, and the step moves on once the push exists.
    sc.add({ type: "user-done", request: ID, key: "approve-push:unskip" });
    assert.deepEqual(sc.settle(), ["push:unskip"]);
    assert.deepEqual(sc.plan("push:unskip").cli?.args, ["push", "--cwd", `/wt/${ID}-signal`, "--expect-commits", "c2,c1", "--", "fuzzy", "-q", "xpcshell"]);
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
    assert.deepEqual(sc.view().jobs.filter((j) => !j.end).map((j) => j.purpose.key), ["prior-art:i-test-a"]);
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

  it("the second group of a test finding someone active asks as the first group", () => {
    const sc = workList([group("ka", "a/test_a.js", "boom"), group("kb", "a/test_a.js", "bang")]);
    for (const item of ["i-test-a", "i-test-a-2"]) sc.complete(`prior-art:${item}`, { output: { bugs: [] } });
    sc.settle();
    sc.complete("prior-art-verdict:i-test-a", { report: none });
    sc.complete("prior-art-verdict:i-test-a-2", { report: { verdict: "active", bug: 77, quote: "assigned to janv", feedback: [] } });
    assert.deepEqual(sc.settle(), ["wt:i-test-a"]);
    assert.deepEqual(sc.open(), ["take-it:i-test-a"]);
    const flag = sc.state().needsUser[0];
    assert.equal(flag.item, "i-test-a");
    assert.equal(flag.detail, "assigned to janv", "no such bug in the prior art: its quote");
    sc.add({ type: "user-done", request: ID, key: "take-it:i-test-a" });
    assert.deepEqual(sc.settle(), ["wt:i-test-a-2"]);
  });

  it("two groups of one test ask once, on the first, with the bug the verdict names; take it lets both go on", () => {
    const sc = workList([group("ka", "a/test_a.js", "boom"), group("kb", "a/test_a.js", "bang")]);
    const bug = { id: 77, summary: "Intermittent test_a.js", status: "ASSIGNED", product: "Core", component: "DOM", keywords: [], assignee: "janv", lastHumanComment: null, revisions: [] };
    for (const item of ["i-test-a", "i-test-a-2"]) sc.complete(`prior-art:${item}`, { output: { bugs: [bug] } });
    sc.settle();
    for (const item of ["i-test-a", "i-test-a-2"]) sc.complete(`prior-art-verdict:${item}`, { report: { verdict: "active", bug: 77, quote: "assigned to janv", feedback: [] } });
    assert.deepEqual(sc.settle(), []);
    assert.deepEqual(sc.open(), ["take-it:i-test-a"]);
    const flag = sc.state().needsUser[0];
    assert.equal(flag.action, "Someone else may be fixing test_a.js");
    assert.equal(flag.detail, "Bug 77 - Intermittent test_a.js (ASSIGNED, assigned to janv).");
    assert.equal(flag.item, "i-test-a");
    sc.add({ type: "user-done", request: ID, key: "take-it:i-test-a" });
    assert.deepEqual(sc.settle().sort(), ["wt:i-test-a", "wt:i-test-a-2"]);
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
    assert.deepEqual(review.agent?.vars, { sha: sha("1"), worktree: `/wt/${ID}-i-test-a`, report: `/state/requests/${ID}/reports/${job}.json` });
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
      sc.complete(`import:${job}`, { output: imported(commit, "Bug XXXXXXX - Fix", ["a/test_a.js"]) });
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
        assert.deepEqual(started, []);
        assert.equal(sc.state().items["i-test-a"].state, "blocked");
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
    assert.equal(sc.state().items["i-test-a"].state, "blocked");
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
  function asking(sc: Scenario): { job: string; planKey: string } {
    sc.complete("author:i-test-a:initial", { report: fixed([sha("1")], { tryRequest: "test_a.js on linux debug, to see the race" }) });
    const job = sc.view().byKey.get("author:i-test-a:initial")![0].job;
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
    assert.deepEqual(sc.open(), [`approve-push:${push}`]);
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
    assert.deepEqual(sc.settle(), [], "the same commit's lint stands; no new review");
    assert.ok(!sc.view().byKey.has(`review:p-test-a:${second}`));
    assert.deepEqual(sc.open(), [`failed:${review}`]);
    const flag = sc.state().needsUser[0];
    assert.equal(flag.action, "Its author left the patch unchanged after the critical review");
    assert.equal(flag.detail, "the race can't happen");
    assert.equal(flag.item, "i-test-a");
    assert.equal(sc.state().items["i-test-a"].state, "blocked");
    sc.add({ type: "item-state", request: ID, item: "i-test-a", state: "reviewed", detail: "accepted by you" });
    sc.add({ type: "user-done", request: ID, key: `failed:${review}` });
    assert.deepEqual(sc.settle(), ["wt:a"], "on to the stack, no review");
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
  sc.complete("wt:a", { output: { name: `${ID}-a`, path: `/wt/${ID}-a`, branch: `${ID}-a` } });
  sc.settle();
  const key = sc.view().jobs.find((j) => j.purpose.what === "assemble")!.purpose.key;
  sc.complete(key, { output: { branch: `${ID}-a`, commits: [{ sha: sha("1"), newSha: sha("a") }, { sha: sha("2"), newSha: sha("b") }], skipped: [], empty: [] } });
  sc.settle();
  const hash = key.split(":")[2];
  sc.complete(`deps:a:${hash}`, { output: [] });
  sc.complete(`effort:p-test-a:${sha("1")}`, { report: { effort: 2, reason: "r", feedback: [] } });
  sc.complete(`effort:p-test-b:${sha("2")}`, { report: { effort: 1, reason: "r", feedback: [] } });
  sc.settle();
  sc.complete(`order:a:${hash}`, { output: { order: ["p-test-b", "p-test-a"], flippedSoftDeps: [] } });
  sc.settle();
  sc.complete(`reorder:a:${hash}`, { output: { mapping: { [sha("b")]: sha("c"), [sha("a")]: sha("d") } } });
  sc.settle();
  sc.complete(`review-stack:a:${hash}`, { report: { findings: [], addDeps: [], removeDeps: [], feedback: [] } });
  sc.settle();
  sc.complete(`summary:a:${hash}`, { output: { markdown: "| table |", metaComment: "This stack fixes 2 failures." } });
  sc.settle();
  return sc;
}

describe("4b. try repro", () => {
  it("pushes the folder's DEBUG commits in one try push once you approve it, then gives each author the results", () => {
    const sc = workList([group("ka", "a/test_a.js", "boom"), group("kb", "a/test_b.js", "bang")]);
    investigating(sc, "i-test-a");
    investigating(sc, "i-test-b");
    sc.complete("author:i-test-a:initial", { report: fixed([sha("d")], { state: "needs a try repro", summary: "the race only shows on mac debug" }) });
    sc.settle();
    assert.equal(sc.state().items["i-test-a"].state, "waiting for a try repro");
    assert.ok(![...sc.view().byKey.keys()].some((k) => k.startsWith("wt:repro:")), "waits for the folder's other groups");
    reviewed(sc, "i-test-b", sha("2"), "a/test_b.js");
    const wt = [...sc.view().byKey.keys()].find((k) => k.startsWith("wt:repro:"))!;
    assert.ok(wt);
    const hash = wt.split(":")[2];
    assert.ok(!sc.view().byKey.has("wt:a"), "no stack while a group of the folder waits for its repro");
    sc.complete(wt, { output: { name: `${ID}-repro`, path: `/wt/${ID}-repro`, branch: `${ID}-repro` } });
    sc.settle();
    assert.deepEqual(sc.plan(`repro-branch:${hash}`).cli?.args.slice(-2), ["--leave-conflict", sha("d")]);
    sc.complete(`repro-branch:${hash}`, { output: { branch: `${ID}-repro`, commits: [{ sha: sha("d"), newSha: sha("e") }] } });
    sc.settle();
    sc.complete(`plan:repro:${hash}`, { report: { pushes: [{ purpose: "repro on mac debug", tryArgs: ["fuzzy", "-q", "mac"], rebuild: 10 }], feedback: [] } });
    sc.settle();
    const push = `repro-${hash.slice(0, 6)}`;
    sc.complete(`dry-run:${push}`, { output: { command: ["./mach", "try", "fuzzy"], taskCount: 4, tasks: [], tryTaskConfig: {}, commits: [sha("e")], warnings: [] } });
    sc.settle();
    assert.ok(sc.open().includes(`approve-push:${push}`), "nothing is pushed before you approve");
    assert.ok(!sc.view().byKey.has(`push:${push}`));
    sc.add({ type: "user-done", request: ID, key: `approve-push:${push}` });
    sc.settle();
    sc.complete(`push:${push}`, { output: { rev: "fff", landoJobId: 1, treeherderUrl: "t" } });
    sc.settle();
    sc.add({ type: "try-finished", request: ID, push, result: "failures", summary: "3 failures" });
    sc.settle();
    const resumed = sc.plan(`author:i-test-a:repro:${hash}`);
    assert.match(resumed.agent?.message ?? "", /fff \(3 failures\)[^]*drop your DEBUG commits/);
    assert.equal(sc.state().items["i-test-a"].state, "investigating");
  });
});

describe("5. stack", () => {
  it("assembles a settled folder, finds deps and efforts, orders, reviews the stack and summarizes it", () => {
    const sc = twoReviewed();
    assert.equal(sc.state().step, "stack");
    assert.deepEqual(sc.view().jobs.filter((j) => !j.end).map((j) => j.purpose.key), ["wt:a"]);
    sc.complete("wt:a", { output: { name: `${ID}-a`, path: `/wt/${ID}-a`, branch: `${ID}-a` } });
    const [assemble] = sc.settle();
    assert.match(assemble, /^assemble:a:[0-9a-f]{10}$/);
    assert.deepEqual(sc.plan(assemble).cli?.args, ["assemble", "--cwd", `/wt/${ID}-a`, "--branch", `${ID}-a`, "--base", "origin/main", "--leave-conflict", sha("1"), sha("2")]);
    sc.complete(assemble, { output: { branch: `${ID}-a`, commits: [{ sha: sha("1"), newSha: sha("a") }, { sha: sha("2"), newSha: sha("b") }], skipped: [], empty: [] } });
    assert.equal(sc.state().patches["p-test-a"].sha, sha("a"));
    assert.equal(sc.state().patches["p-test-a"].worktree, `/wt/${ID}-a`);
    const hash = assemble.split(":")[2];
    assert.deepEqual(sc.settle().sort(), [`deps:a:${hash}`, `effort:p-test-a:${sha("1")}`, `effort:p-test-b:${sha("2")}`]);
    sc.complete(`deps:a:${hash}`, { output: [{ patch: sha("a"), needs: sha("b"), kind: "hard", reason: "textual", source: "textual" }] });
    assert.deepEqual(sc.state().patches["p-test-a"].deps.map((d) => d.needs), ["p-test-b"]);
    sc.complete(`effort:p-test-a:${sha("1")}`, { report: { effort: 2, reason: "r", feedback: [] } });
    sc.complete(`effort:p-test-b:${sha("2")}`, { report: { effort: 1, reason: "r", feedback: [] } });
    assert.deepEqual(sc.settle(), [`order:a:${hash}`]);
    const input = JSON.parse(sc.plan(`order:a:${hash}`).files![0].content);
    assert.deepEqual(input.patches, [{ id: "p-test-a", effort: 2, value: 3, testOnly: true }, { id: "p-test-b", effort: 1, value: 1, testOnly: true }]);
    sc.complete(`order:a:${hash}`, { output: { order: ["p-test-b", "p-test-a"], flippedSoftDeps: [] } });
    assert.deepEqual(sc.settle(), [`reorder:a:${hash}`]);
    assert.deepEqual(sc.plan(`reorder:a:${hash}`).cli?.args.slice(-2), ["--order", `${sha("b")},${sha("a")}`]);
    sc.complete(`reorder:a:${hash}`, { output: { mapping: { [sha("b")]: sha("c"), [sha("a")]: sha("d") } } });
    assert.deepEqual(sc.settle(), [`review-stack:a:${hash}`]);
    assert.deepEqual(sc.state().stacks.a.order, ["p-test-b", "p-test-a"]);
    assert.equal(sc.state().patches["p-test-b"].sha, sha("c"));
    sc.complete(`review-stack:a:${hash}`, { report: { findings: [{ patch: sha("c"), severity: "nit", text: "typo" }], addDeps: [], removeDeps: [], feedback: [] } });
    assert.deepEqual(sc.settle(), [`summary:a:${hash}`]);
    sc.complete(`summary:a:${hash}`, { output: { markdown: "| table |", metaComment: "This stack fixes 2 failures." } });
    sc.settle();
    const s = sc.state();
    assert.equal(s.stacks.a.summary, "This stack fixes 2 failures.");
    assert.equal(s.items["i-test-a"].state, "in stack");
    assert.equal(s.step, "verify on try");
  });

  it("names a stack after its folder, cutting its first parts to one letter so the last ones fit", () => {
    assert.equal(stackId("dom/base/test"), "dom-base-test");
    assert.equal(stackId("browser/components/enterprisepolicies/tests/browser"), "b-c-enterprisepolicies-tests-browser");
    assert.equal(stackId("browser/components/enterprisepolicies/tests/xpcshell"), "b-c-enterprisepolicies-tests-xpcshell");
    assert.equal(stackId(""), "root");
  });

  it("gives two folders whose names start alike their own stacks", () => {
    const long = "a".repeat(45);
    const sc = workList([group("ka", `${long}/x/test_a.js`, "boom"), group("kb", `${long}/y/test_b.js`, "bang")]);
    investigating(sc, "i-test-a");
    investigating(sc, "i-test-b");
    reviewed(sc, "i-test-a", sha("1"), `${long}/x/test_a.js`);
    reviewed(sc, "i-test-b", sha("2"), `${long}/y/test_b.js`);
    const wts = sc.view().jobs.filter((j) => j.purpose.key.startsWith("wt:a")).map((j) => j.purpose.key);
    assert.equal(new Set(wts).size, 2, JSON.stringify(wts));
  });

  it("goes on when an author reported its commit by a short sha", () => {
    const sc = workList([group("ka", "a/test_a.js", "boom")]);
    investigating(sc, "i-test-a");
    reviewed(sc, "i-test-a", sha("1").slice(0, 12), "a/test_a.js");
    sc.complete("wt:a", { output: { name: `${ID}-a`, path: `/wt/${ID}-a`, branch: `${ID}-a` } });
    const [assemble] = sc.settle();
    sc.complete(assemble, { output: { branch: `${ID}-a`, commits: [{ sha: sha("1"), newSha: sha("a") }], skipped: [], empty: [] } });
    assert.ok(sc.settle().includes(`deps:a:${assemble.split(":")[2]}`));
  });

  it("drops the ⚑ of a job of an earlier version of the stack", () => {
    const sc = twoReviewed();
    sc.startJob({ purpose: { key: "review-stack:a:0123456789", what: "review-stack", stack: "a" }, kind: "agent", name: "review-stack", cwd: "/wt", agent: { sessionId: "s-old", resume: false, message: "x" } });
    const old = sc.running("review-stack:a:0123456789");
    sc.complete("review-stack:a:0123456789", { exitCode: -1, error: "cancelled by you" });
    sc.add({ type: "needs-user", request: ID, key: `stopped:${old}`, action: "stopped", detail: "", job: old });
    sc.settle();
    assert.ok(!sc.open().includes(`stopped:${old}`));
  });

  it("waits for every item of the folder", () => {
    const sc = workList([group("ka", "a/test_a.js", "boom"), group("kb", "a/test_b.js", "bang")]);
    investigating(sc, "i-test-a");
    investigating(sc, "i-test-b");
    reviewed(sc, "i-test-a", sha("1"), "a/test_a.js");
    assert.ok(!sc.view().byKey.has("wt:a"));
  });

  it("sends a stack review's must-fix finding to that patch's author", () => {
    const sc = twoReviewed();
    sc.complete("wt:a", { output: { path: `/wt/${ID}-a` } });
    sc.settle();
    const key = sc.view().jobs.find((j) => j.purpose.what === "assemble")!.purpose.key;
    const hash = key.split(":")[2];
    sc.complete(key, { output: { commits: [{ sha: sha("1"), newSha: sha("a") }, { sha: sha("2"), newSha: sha("b") }] } });
    sc.settle();
    sc.complete(`deps:a:${hash}`, { output: [] });
    sc.complete(`effort:p-test-a:${sha("1")}`, { report: { effort: 2, reason: "r", feedback: [] } });
    sc.complete(`effort:p-test-b:${sha("2")}`, { report: { effort: 1, reason: "r", feedback: [] } });
    sc.settle();
    sc.complete(`order:a:${hash}`, { output: { order: ["p-test-a", "p-test-b"], flippedSoftDeps: [] } });
    assert.deepEqual(sc.settle(), [`review-stack:a:${hash}`]);
    const review = sc.complete(`review-stack:a:${hash}`, { report: { findings: [{ patch: sha("b"), severity: "must-fix", text: "same approach as test_a" }], addDeps: [], removeDeps: [], feedback: [] } });
    assert.deepEqual(sc.settle(), [`author:i-test-b:stack-review:${review}`]);
    assert.match(sc.plan(`author:i-test-b:stack-review:${review}`).agent?.message ?? "", /same approach as test_a/);
    assert.equal(sc.state().items["i-test-b"].state, "investigating");
  });

  it("hands a text conflict to resolve-conflict, then assembles the rest", () => {
    const sc = twoReviewed();
    sc.complete("wt:a", { output: { path: `/wt/${ID}-a` } });
    sc.settle();
    const key = sc.view().jobs.find((j) => j.purpose.what === "assemble")!.purpose.key;
    const hash = key.split(":")[2];
    sc.complete(key, { output: { commits: [], conflict: { sha: sha("1"), files: ["a/test_a.js"] }, remaining: [sha("2")] } });
    assert.deepEqual(sc.settle(), [`resolve:a:${hash}:${sha("1")}`]);
    assert.deepEqual(sc.plan(`resolve:a:${hash}:${sha("1")}`).agent?.vars, { sha: sha("1"), base: `${ID}-a`, files: "a/test_a.js" });
    sc.complete(`resolve:a:${hash}:${sha("1")}`, { report: { state: "resolved", commit: sha("a"), explanation: "kept both", feedback: [] } });
    assert.equal(sc.state().patches["p-test-a"].sha, sha("a"));
    const rest = `assemble:a:${hash}:after:${sha("1").slice(0, 12)}`;
    assert.deepEqual(sc.settle(), [rest]);
    assert.deepEqual(sc.plan(rest).cli?.args, ["assemble", "--cwd", `/wt/${ID}-a`, "--branch", `${ID}-a`, "--leave-conflict", sha("2")]);
    sc.complete(rest, { output: { commits: [{ sha: sha("2"), newSha: sha("b") }] } });
    assert.ok(sc.settle().includes(`deps:a:${hash}`));
  });
});

describe("6. verify on try", () => {
  it("plans the pushes, then routes matched failures to their author and the rest to triage", () => {
    const sc = stacked();
    assert.equal(sc.state().step, "verify on try");
    const planKey = sc.view().jobs.find((j) => j.purpose.what === "plan-pushes")!.purpose.key;
    const vars = sc.plan(planKey).agent!.vars!;
    assert.equal(vars.branch, `${ID}-a`);
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
      { sha: sha("c"), title: "Bug 22 - Fix test_b, r=smaug.", files: ["a/test_b.js"] },
      { sha: sha("d"), title: "Bug XXXXXXX - Fix a/test_a.js, r=smaug.", files: ["a/test_a.js"] },
    ]);
    assert.deepEqual([input.rev, input.rows.map((r: { test: string }) => r.test), input.unparsed], ["fed", ["z/test_z.js"], []]);
    sc.complete(`triage:${push}:final:v2`, { report: { cells: [{ test: "z/test_z.js", verdict: "broken by patch", patch: sha("c"), evidence: "TypeError" }], feedback: [] } });
    assert.deepEqual(sc.settle(), [`author:i-test-b:try:${push}`]);
    assert.equal(sc.state().step, "verify on try");
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
    sc.complete("reviewers:a", { output: { files: [], suggestions: [{ name: "#gone-reviewers", source: "recent" }] } });
    const [own] = sc.settle();
    sc.complete(own, { output: { files: [], suggestions: [{ name: "#gone-reviewers", source: "recent" }] } });
    assert.ok(!sc.settle().some((k) => k.startsWith("rewrite-reviewers:")), "no rewrite that can't help");
    assert.ok(sc.open().includes("reviewers:a"));
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

  it("sends a push you revise back to the agent that planned it, in its session; what it returns replaces that push alone; and its replacement too", () => {
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

    sc.complete(rev1, { report: { pushes: [{ purpose: "mac", tryArgs: ["fuzzy", "-q", "mac"], rebuild: 5 }], feedback: [] } });
    const [dry1] = sc.settle();
    const v1 = sc.purpose(dry1).push!;
    assert.equal(v1, `${keep}-v1`);
    sc.complete(dry1, { output: dryOut });
    sc.settle();
    assert.deepEqual(sc.open().sort(), [`approve-push:${keep}`, `approve-push:${v1}`].sort());

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
    assert.deepEqual(sc.open(), ["unverified:a"]);

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
    const plan3 = sc.settle().find((k) => k.startsWith("plan:verify:"))!;
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
  it("drafts the meta bug, and its number goes in every patch without a bug of its own", () => {
    const sc = verified();
    const s = sc.state();
    assert.equal(s.metaBug?.bug, null);
    assert.deepEqual(s.metaBug?.draft?.keywords, ["meta"]);
    assert.equal(s.metaBug?.draft?.description, "This stack fixes 2 failures.");
    assert.deepEqual(sc.open(), ["meta-bug:a"]);
    sc.add({ type: "meta-bug", request: ID, bug: 999, draft: s.metaBug!.draft });
    sc.add({ type: "user-done", request: ID, key: "meta-bug:a" });
    const [rewrite] = sc.settle();
    assert.match(rewrite, /^rewrite-bugs:a:/);
    assert.deepEqual(JSON.parse(sc.plan(rewrite).files![0].content), { [sha("d")]: { bug: 999 } });
    sc.complete(rewrite, { output: { mapping: { [sha("c")]: sha("e"), [sha("d")]: sha("f") } } });
    assert.equal(sc.state().patches["p-test-a"].title, "Bug 999 - Fix a/test_a.js, r=smaug.");
    assert.equal(sc.state().patches["p-test-a"].bug, 999);
    sc.settle();
    assert.equal(sc.state().step, "submit");
  });

  it("a patch already on Phabricator gets its Differential Revision line along with its bug", () => {
    const sc = verified();
    const { deps: _d, review: _r, replyDrafts: _rd, id, ...p } = sc.state().patches["p-test-a"];
    sc.add({ type: "patch", request: ID, patch: id, ...p, revision: 7 });
    sc.add({ type: "meta-bug", request: ID, bug: 999 });
    sc.add({ type: "user-done", request: ID, key: "meta-bug:a" });
    const [rewrite] = sc.settle();
    assert.match(rewrite, /^rewrite-bugs:a:/);
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
  sc.add({ type: "meta-bug", request: ID, bug: 999 });
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
  it("checks the stack, asks you to submit, and notices the Differential Revision trailers", () => {
    const sc = submitting();
    assert.equal(sc.state().step, "submit");
    assert.deepEqual(sc.plan("reviewers:a").cli?.args, ["reviewers", "a/test_b.js", "a/test_a.js", "--repo", `/wt/${ID}-a`]);
    sc.complete("reviewers:a", { output: { files: [], suggestions: [{ name: "smaug", source: "mots" }] } });
    const [check] = sc.settle();
    assert.match(check, /^check:a:/);
    assert.deepEqual(JSON.parse(sc.plan(check).files![0].content).map((p: { result: string }) => p.result), ["green"]);
    sc.complete(check, { output: { ok: true, failures: [] } });
    assert.deepEqual(sc.settle(), [], "nothing looks for revisions before you copy the moz-phab command");
    assert.deepEqual(sc.open(), ["submit:a"]);
    sc.add({ type: "submit-copied", request: ID, stack: "a" });
    assert.deepEqual(sc.settle(), ["import-submit:a:0"]);
    sc.complete("import-submit:a:0", { output: imported(sha("e"), "Bug 22 - Fix test_b, r=smaug.", [], 22).concat(imported(sha("f"), "Bug 999 - Fix a, r=smaug.", [], 999)) });
    assert.deepEqual(sc.settle(), []);
    sc.now += 2 * 60_000;
    assert.deepEqual(sc.settle(), ["import-submit:a:1"]);
    const withRevisions = [
      { ...imported(sha("e"), "Bug 22 - Fix test_b, r=smaug.", [], 22)[0], revision: 100 },
      { ...imported(sha("f"), "Bug 999 - Fix a, r=smaug.", [], 999)[0], revision: 101 },
    ];
    sc.complete("import-submit:a:1", { output: withRevisions });
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
    sc.complete("reviewers:a", { output: { files: [], suggestions: [{ name: "#dom-core", source: "mots" }] } });
    const [own] = sc.settle();
    assert.deepEqual(sc.plan(own).cli?.args, ["reviewers", "a/test_a.js", "--repo", `/wt/${ID}-a`], "the suggestion for its own files");
    sc.complete(own, { output: { files: [], suggestions: [{ name: "#xpcshell-reviewers", source: "mots" }] } });
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
    sc.complete("reviewers:a", { output: { files: [], suggestions: [{ name: "#dom-core", source: "mots" }] } });
    const own = sc.settle().find((k) => k.startsWith("reviewers:"))!;
    sc.complete(own, { output: { files: [], suggestions: [] } });
    const [rewrite] = sc.settle();
    assert.match(rewrite, /^rewrite-reviewers:a:/);
    assert.deepEqual(JSON.parse(sc.plan(rewrite).files![0].content), {
      [sha("f")]: { message: "Bug 999 - Fix a, r=#dom-core.\n\nBody.\n", bug: 999, revision: "https://phabricator.services.mozilla.com/D101" },
    });
  });

  it("adds the suggested reviewer to patches without r=, then shows failed checks to you", () => {
    const sc = submitting();
    const s = sc.state();
    const { deps: _d, review: _r, replyDrafts: _rd, id, ...p } = s.patches["p-test-a"];
    sc.add({ type: "patch", request: ID, patch: id, ...p, title: "Bug 999 - Fix a" });
    sc.complete("reviewers:a", { output: { files: [], suggestions: [{ name: "#dom-core", source: "mots" }] } });
    sc.complete(sc.settle()[0], { output: { files: [], suggestions: [] } });
    const [rewrite] = sc.settle();
    assert.match(rewrite, /^rewrite-reviewers:a:/, "without a suggestion for its own files, the stack's");
    const edits = JSON.parse(sc.plan(rewrite).files![0].content);
    assert.equal(edits[sha("f")].message, "Bug 999 - Fix a, r=#dom-core.\n\nBody.\n");
    sc.complete(rewrite, { output: { mapping: { [sha("f")]: sha("9") } } });
    assert.equal(sc.state().patches["p-test-a"].title, "Bug 999 - Fix a, r=#dom-core.");
    reviewersChecked(sc);
    assert.deepEqual(sc.plan(sc.view().jobs.filter((j) => j.purpose.what === "check-reviewers").at(-1)!.purpose.key).cli?.args, ["check-reviewers", "smaug", "#dom-core"]);
    const check = sc.view().jobs.find((j) => !j.end && j.purpose.key.startsWith("check:a:"))!.purpose.key;
    const job = sc.complete(check, { output: { ok: false, failures: [{ rule: "try", message: "try isn't green" }] } });
    sc.settle();
    assert.deepEqual(sc.open(), [`failed:${job}`]);
  });
});

function inReview(): Scenario {
  const sc = submitting();
  sc.complete("reviewers:a", { output: { files: [], suggestions: [] } });
  const [check] = sc.settle();
  sc.complete(check, { output: { ok: true, failures: [] } });
  sc.add({ type: "submit-copied", request: ID, stack: "a" });
  sc.settle();
  sc.complete("import-submit:a:0", {
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

describe("9. review comments", () => {
  it("polls Phabricator every 10 min while you're present, every 3 h while you're away", () => {
    const sc = inReview();
    assert.deepEqual(sc.view().jobs.filter((j) => !j.end).map((j) => j.purpose.key), ["poll:0"]);
    assert.deepEqual(sc.plan("poll:0").cli?.args, ["poll", "D100", "D101"]);
    assert.equal(sc.plan("poll:0").priority, 0);
    sc.complete("poll:0", { output: polled("needs-review", [], "pending") });
    assert.equal(sc.state().patches["p-test-a"].review?.status, "needs-review");
    sc.now += 9 * 60_000;
    assert.deepEqual(sc.settle(), []);
    sc.now += 60_000;
    assert.deepEqual(sc.settle(), ["poll:1"]);
    sc.complete("poll:1", { output: polled("needs-review", [], "pending") });
    sc.present = false;
    sc.now += 2 * HOUR;
    assert.deepEqual(sc.settle(), []);
    sc.now += HOUR;
    assert.deepEqual(sc.settle(), ["poll:2"]);
    sc.complete("poll:2", { output: polled("needs-review", [], "pending") });
    // Back at the page: the 10 min rule again.
    sc.present = true;
    sc.presentSince = sc.now;
    sc.now += 10 * 60_000;
    assert.deepEqual(sc.settle(), ["poll:3"]);
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
    assert.deepEqual(sc.settle(), [`rewrite-review:a:${job}`]);
    // Its commit lost its Differential Revision line: the rewrite gives every submitted patch its own back.
    const rw = sc.plan(`rewrite-review:a:${job}`);
    assert.deepEqual(rw.cli?.args.slice(-4), ["--order", `${sha("e")},${sha("7")}`, "--edits", rw.files![0].path]);
    assert.deepEqual(JSON.parse(rw.files![0].content), {
      [sha("e")]: { revision: "https://phabricator.services.mozilla.com/D100" },
      [sha("7")]: { revision: "https://phabricator.services.mozilla.com/D101" },
    });
    sc.complete(`rewrite-review:a:${job}`, { output: { mapping: { [sha("e")]: sha("e"), [sha("7")]: sha("8") } } });
    assert.deepEqual(sc.settle(), [`interdiff:p-test-a:${job}`]);
    assert.deepEqual(sc.plan(`interdiff:p-test-a:${job}`).cli?.args, ["interdiff", "--cwd", `/wt/${ID}-a`, sha("1"), sha("8")]);
    const inter = sc.complete(`interdiff:p-test-a:${job}`, { output: { diff: "-a\n+b\n", method: "same-parent" } });
    assert.equal(sc.state().patches["p-test-a"].interdiffFile, `requests/${ID}/data/interdiff-p-test-a-${inter}.diff`);
    sc.settle();
    const n = sc.state().needsUser.find((x) => x.key.startsWith("resubmit:"))!;
    assert.equal(n.action, "Post 1 reply, then resubmit D101");
    assert.equal(n.stack, "a");
    assert.equal(sc.state().items["i-test-a"].state, "waiting for review");
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
    assert.deepEqual(sc.settle(), [`rewrite-review:a:${pass}`]);
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
      sc.complete("reviewers:a", { output: { files: [], suggestions: [] } });
      const [check] = sc.settle();
      sc.complete(check, { output: { ok: true, failures: [] } });
      sc.add({ type: "submit-copied", request: ID, stack: "a" });
      sc.settle();
      // While you submit.
      start();
      sc.complete("import-submit:a:0", {
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
      assert.deepEqual(sc.settle(), [`rewrite-review:a:${job}`]);
      const rw = sc.plan(`rewrite-review:a:${job}`);
      assert.deepEqual(JSON.parse(rw.files![0].content)[sha("7")], { revision: "https://phabricator.services.mozilla.com/D101" });
      sc.complete(`rewrite-review:a:${job}`, { output: { mapping: { [sha("e")]: sha("e"), [sha("7")]: sha("8") } } });
      const [inter] = sc.settle();
      assert.equal(inter, `interdiff:p-test-a:${job}`);
      sc.complete(inter, { output: { diff: "-a\n+b\n", method: "same-parent" } });
      sc.settle();
      const n = sc.state().needsUser.find((x) => x.key.startsWith("resubmit:"))!;
      assert.equal(n.action, "Resubmit D101");
      assert.equal(n.detail, "changed by its author since you submitted it and re-reviewed (Opus) · interdiff below");
      assert.equal(sc.state().items["i-test-a"].state, "waiting for review");
    });
  }

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
    sc.complete("poll:0", { output: polled("accepted") });
    sc.settle();
    assert.equal(sc.state().step, "landing");
    const key = sc.view().jobs.find((j) => j.purpose.key.startsWith("order-landable:"))!.purpose.key;
    assert.deepEqual(sc.plan(key).cli?.args.slice(-1), ["--landable"]);
    sc.complete(key, { output: { order: ["p-test-a", "p-test-b"], flippedSoftDeps: [{ patch: "p-test-b", needs: "p-test-a", kind: "soft", reason: "shares a helper", source: "agent" }], landable: ["p-test-a", "p-test-b"] } });
    const [rewrite] = sc.settle();
    assert.match(rewrite, /^rewrite-land:a:/);
    assert.deepEqual(JSON.parse(sc.plan(rewrite).files![0].content), { [sha("e")]: { revision: "https://phabricator.services.mozilla.com/D100" }, [sha("f")]: { revision: "https://phabricator.services.mozilla.com/D101" } });
    sc.complete(rewrite, { output: { mapping: { [sha("f")]: sha("5"), [sha("e")]: sha("6") } } });
    const [adapt] = sc.settle();
    assert.equal(sc.plan(adapt).name, "adapt-soft-dep");
    assert.deepEqual(sc.plan(adapt).agent?.vars, { patchA: sha("6"), patchB: sha("5"), reason: "shares a helper" });
    sc.complete(adapt, { report: { state: "adapted", commits: [sha("5"), sha("4")], summary: "s", feedback: [] } });
    const [refresh] = sc.settle();
    sc.complete(refresh, { output: [{ ...imported(sha("5"), "Bug 999 - Fix a, r=smaug.", [], 999)[0], revision: 101 }, { ...imported(sha("4"), "Bug 22 - Fix test_b, r=smaug.", [], 22)[0], revision: 100 }] });
    sc.settle();
    const flag = sc.state().needsUser.find((n) => n.key.startsWith("land:a:"))!;
    assert.equal(flag.key, `land:a:${key.split(":").at(-1)}`);
    assert.equal(flag.action, "Stack reordered: 2 landable patches moved to the bottom");
    assert.equal(flag.detail, "Run moz-phab reorg so Phabricator has the new order (1 soft dependency adapted).");
    assert.equal(flag.stack, "a");

    sc.now += 3 * HOUR;
    sc.settle();
    sc.complete("poll:1", { output: polled("published") });
    sc.settle();
    const s = sc.state();
    assert.equal(s.step, "done");
    assert.equal(s.items["i-test-a"].state, "landed");
    // Worktrees go, removed from the main checkout, never from inside themselves.
    const removes = sc.view().jobs.filter((j) => j.purpose.what === "remove");
    assert.deepEqual(removes.map((j) => j.purpose.key).sort(), [`remove:${ID}-a`, `remove:${ID}-i-test-a`, `remove:${ID}-i-test-b`].sort());
    assert.ok(removes.every((j) => j.cwd === config.firefoxRepo));
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
    sc.add({ type: "needs-user", request: ID, key: "land:a:old", action: "Stack reordered", detail: "", stack: "a" });
    sc.complete(key, { output: { order: sc.state().stacks.a.order, flippedSoftDeps: [], landable: ["p-test-b"] } });
    assert.deepEqual(sc.settle(), []);
    assert.ok(!sc.view().jobs.some((j) => j.purpose.key.startsWith("rewrite-land:")));
    assert.deepEqual(sc.open().filter((k) => k.startsWith("land:")), []);
  });

  it("says nothing about soft dependencies when none was adapted, and stays answered once you copied the reorg", () => {
    const { sc, key } = accepted();
    const order = [...sc.state().stacks.a.order].reverse();
    sc.complete(key, { output: { order, flippedSoftDeps: [], landable: [order[0]] } });
    const [rewrite] = sc.settle();
    sc.complete(rewrite, { output: { mapping: { [sha("f")]: sha("5"), [sha("e")]: sha("6") } } });
    sc.settle();
    const flag = sc.state().needsUser.find((n) => n.key.startsWith("land:a:"))!;
    assert.equal(flag.action, "Stack reordered: 1 landable patch moved to the bottom");
    assert.equal(flag.detail, "Run moz-phab reorg so Phabricator has the new order.");
    sc.add({ type: "user-done", request: ID, key: flag.key });
    sc.settle();
    assert.deepEqual(sc.open().filter((k) => k.startsWith("land:")), [], "not raised again");
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

describe("burndown verification", () => {
  it("pushes the stack with the DEBUG commit on top, then checks the stack branch out again before submitting", () => {
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
    reviewed(sc, "i-test-a", sha("1"), "a/test_a.js");
    sc.complete("wt:a", { output: { name: `${ID}-a`, path: `/wt/${ID}-a`, branch: `${ID}-a` } });
    sc.settle();
    const hash = sc.view().jobs.find((j) => j.purpose.what === "assemble")!.purpose.key.split(":")[2];
    sc.complete(`assemble:a:${hash}`, { output: { commits: [{ sha: sha("1"), newSha: sha("a") }] } });
    sc.settle();
    sc.complete(`deps:a:${hash}`, { output: [] });
    sc.complete(`effort:p-test-a:${sha("1")}`, { report: { effort: 1, reason: "r", feedback: [] } });
    sc.settle();
    sc.complete(`order:a:${hash}`, { output: { order: ["p-test-a"], flippedSoftDeps: [] } });
    sc.settle();
    sc.complete(`review-stack:a:${hash}`, { report: { findings: [], addDeps: [], removeDeps: [], feedback: [] } });
    sc.settle();
    sc.complete(`summary:a:${hash}`, { output: { markdown: "t", metaComment: "m" } });
    const [sync, tryBranch] = sc.settle();
    assert.equal(sc.state().step, "verify on try");
    assert.match(sync, /^sync:a:/, "its reviewers are right before you may submit");
    reviewersChecked(sc);
    sc.complete("reviewers:a", { output: { files: [], suggestions: [] } });

    // The stack branch plus the DEBUG commit, on a branch of its own: that's what try gets.
    assert.equal(tryBranch, `try-branch:a:${hash}`);
    const args = sc.plan(tryBranch).cli!.args;
    assert.deepEqual([args[0], args[4].startsWith(`${ID}-a-try-`), ...args.slice(5)], ["assemble", true, "--base", `${ID}-a`, sha("9")]);
    sc.complete(tryBranch, { output: { branch: args[4], head: sha("b"), commits: [{ sha: sha("9"), newSha: sha("b") }] } });
    const [planKey] = sc.settle();
    assert.equal(sc.plan(planKey).agent?.vars?.branch, args[4]);
    assert.equal(sc.state().patches["p-test-a"].sha, sha("a"));
    sc.complete(planKey, { report: { pushes: [{ purpose: "verify", tryArgs: ["fuzzy", "-q", "x"], rebuild: 5 }], feedback: [] } });
    const [dry] = sc.settle();
    const push = sc.purpose(dry).push!;
    sc.complete(dry, { output: { command: ["./mach", "try", "fuzzy"], taskCount: 5, tasks: [], tryTaskConfig: {}, commits: [sha("b"), sha("a")], warnings: [] } });
    sc.add({ type: "user-done", request: ID, key: `approve-push:${push}` });
    sc.add({ type: "try-pushed", request: ID, push, rev: "fed", url: "u" });
    sc.add({ type: "try-finished", request: ID, push, result: "green", summary: "green" });
    sc.settle();
    sc.complete(`try-table:${push}:final`, { output: table() });
    sc.settle();
    assert.equal(sc.state().step, "meta bug");
    sc.add({ type: "meta-bug", request: ID, bug: 999 });
    const [rewrite] = sc.settle();
    sc.complete(rewrite, { output: { mapping: { [sha("a")]: sha("c") } } });
    sc.settle();

    // Before submitting, the stack's own branch, without the DEBUG commit, is checked out again.
    assert.equal(sc.state().step, "submit");
    assert.deepEqual(sc.view().jobs.filter((j) => !j.end && !j.purpose.key.startsWith("sync:")).map((j) => j.purpose.key), ["checkout:a"]);
    const checkout = sc.plan("checkout:a");
    assert.deepEqual([checkout.cli, checkout.cwd], [{ tool: "git", args: ["checkout", `${ID}-a`] }, `/wt/${ID}-a`]);
    sc.complete("checkout:a", { output: "" });
    reviewersChecked(sc);
    assert.ok(sc.view().jobs.some((j) => !j.end && j.purpose.key.startsWith("check:a:")));
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
