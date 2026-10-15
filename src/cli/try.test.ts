import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { ExecResult } from "../lib/exec.ts";
import {
  checkTryArgs,
  dryRun,
  fetchJobs,
  findDuplicate,
  parseDryRunOutput,
  parsePushOutput,
  push,
  pushStatus,
  watch,
  type FetchResponse,
  type TreeherderJob,
  type WatchDeps,
  type WatchLine,
} from "./try.ts";

const FIXTURES = new URL("../../test/fixtures/try/", import.meta.url);
const text = (name: string) => readFileSync(new URL(name, FIXTURES), "utf8");
const json = (name: string) => JSON.parse(text(name));

const REV = "d25e111ef965eff6bb71d4f1d040318133886305";
const COMMITS = ["aaaa", "bbbb"];

interface JobsPage {
  count?: number;
  next: string | null;
  results: unknown[][];
  job_property_names: string[];
}

function rows(page: JobsPage): TreeherderJob[] {
  return page.results.map((r) => Object.fromEntries(page.job_property_names.map((n, i) => [n, r[i]])) as unknown as TreeherderJob);
}

function response(body: unknown, status = 200): FetchResponse {
  return { ok: status < 400, status, json: async () => body };
}

// A fake exec: mach returns the given dry-run fixture, git returns the stack.
function fakeExec(machStdout: string, files = "") {
  const calls: { cmd: string[]; input?: string }[] = [];
  const run = async (cmd: string[], opts: { input?: string } = {}): Promise<ExecResult> => {
    calls.push({ cmd, input: opts.input });
    if (cmd[0] === "./mach") {
      return { code: 0, stdout: machStdout, stderr: "" };
    }
    if (cmd[1] === "rev-list") {
      return { code: 0, stdout: COMMITS.join("\n") + "\n", stderr: "" };
    }
    return { code: 0, stdout: files, stderr: "" };
  };
  return { run, calls };
}

test("checkTryArgs rejects flags and selectors that can't work unattended", () => {
  assert.throws(() => checkTryArgs(["fuzzy", "-q", "'xpcshell", "--no-push"]), /--no-push/);
  assert.throws(() => checkTryArgs(["fuzzy", "-q", "'xpcshell", "--push-to-vcs"]), /--push-to-vcs/);
  assert.throws(() => checkTryArgs(["fuzzy", "--stage-changes", "-q", "x"]), /--stage-changes/);
  assert.throws(() => checkTryArgs(["fuzzy", "xpcom/tests/unit"]), /needs -q/);
  assert.throws(() => checkTryArgs(["chooser"]), /unsupported selector/);
  assert.throws(() => checkTryArgs([]), /missing/);
  checkTryArgs(["fuzzy", "-q", "'xpcshell 'linux2404-64/opt", "--rebuild", "5", "xpcom/tests/unit"]);
  checkTryArgs(["fuzzy", "--query='xpcshell"]);
  checkTryArgs(["auto"]);
});

test("parseDryRunOutput: chunk patterns hide the real task count", () => {
  const p = parseDryRunOutput(text("dry-run-chunk-patterns.txt"));
  assert.deepEqual(p.tasks, ["test-linux2404-64/opt-xpcshell-*"]);
  assert.equal(p.taskCount, 1);
  assert.equal(p.warnings.length, 1);
  assert.match(p.warnings[0], /chunk patterns.*--show-chunk-numbers/);
});

test("parseDryRunOutput: --rebuild multiplies the task count", () => {
  const p = parseDryRunOutput(text("dry-run-rebuild.txt"));
  assert.equal(p.tasks.length, 6);
  assert.equal(p.rebuild, 3);
  assert.equal(p.taskCount, 18);
  assert.deepEqual(p.warnings, []);
  assert.equal(p.tryTaskConfig["use-artifact-builds"], true);
});

test("parseDryRunOutput: large push prompt", () => {
  const p = parseDryRunOutput(text("dry-run-large-push.txt"));
  assert.equal(p.rebuild, 2);
  assert.equal(p.taskCount, p.tasks.length * 2);
  assert.ok(p.warnings.some((w) => /at least 2580 tasks.*lowest priority/.test(w)));
});

test("parseDryRunOutput: no tasks selected", () => {
  assert.throws(() => parseDryRunOutput(text("dry-run-no-tasks.txt")), /no tasks/);
});

test("dryRun runs mach with --no-push and reports the stack", async () => {
  const { run, calls } = fakeExec(text("dry-run-rebuild.txt"));
  const args = ["fuzzy", "-q", "'xpcshell 'linux2404-64/opt", "--rebuild", "3", "--artifact"];
  const r = await dryRun("/wt", args, { exec: run });
  assert.deepEqual(calls[0].cmd, ["./mach", "try", ...args, "--no-push"]);
  assert.equal(calls[0].input, "y\n");
  assert.deepEqual(r.command, ["./mach", "try", ...args]);
  assert.equal(r.taskCount, 18);
  assert.deepEqual(r.commits, COMMITS);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.duplicateOf, undefined);
});

test("dryRun warns about an artifact push of native changes", async () => {
  const { run } = fakeExec(text("dry-run-rebuild.txt"), "xpcom/io/nsLocalFileUnix.cpp\nxpcom/tests/unit/test_x.js\n");
  const r = await dryRun("/wt", ["fuzzy", "-q", "x", "--artifact"], { exec: run });
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /nsLocalFileUnix\.cpp.*--no-artifact/);
});

test("dryRun reports a duplicate of a pending push", async () => {
  const { run } = fakeExec(text("dry-run-rebuild.txt"));
  const tasks = parseDryRunOutput(text("dry-run-rebuild.txt")).tasks;
  const pending = [
    { push: "p1", tasks, commits: ["other"] },
    { push: "p2", tasks: [...tasks].reverse(), commits: COMMITS, taskCount: 18 },
  ];
  const r = await dryRun("/wt", ["fuzzy", "-q", "x"], { exec: run, pending });
  assert.equal(r.duplicateOf, "p2");
  assert.equal(findDuplicate({ tasks, commits: COMMITS, taskCount: 6 }, pending), undefined, "different --rebuild");
  assert.equal(findDuplicate({ tasks: tasks.slice(1), commits: COMMITS, taskCount: 15 }, pending), undefined);
});

// Fake clock and fetch: Lando, Treeherder push and jobs answer from fixtures
// according to the fake time.
function fakeWorld(opts: { landoLandsAt: number; pushAppearsAt: number; jobs: (now: number) => JobsPage; failures?: Set<number> }) {
  let now = opts.landoLandsAt - 5 * 60_000;
  let calls = 0;
  const lines: { t: number; line: WatchLine }[] = [];
  const deps: WatchDeps = {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    emit: (line) => lines.push({ t: now, line }),
    fetch: async (url) => {
      if (opts.failures?.has(calls++)) {
        throw new Error("ECONNRESET");
      }
      if (url.startsWith("https://lando.moz.tools/landing_jobs/103624/")) {
        return response(json(now < opts.landoLandsAt ? "lando-in-progress.json" : "lando-landed.json"));
      }
      if (url === `https://treeherder.mozilla.org/api/project/try/push/?revision=${REV}`) {
        return response(json(now < opts.pushAppearsAt ? "push-unknown.json" : "push-d25e111ef965.json"));
      }
      if (url.startsWith("https://treeherder.mozilla.org/api/jobs/?push_id=2065854&count=")) {
        return response(opts.jobs(now));
      }
      return response({ detail: "not found" }, 404);
    },
  };
  return { deps, lines, now: () => now };
}

const utc = (s: string) => Date.parse(s + "Z");

// Replays a finished push: a job appears when its parent finishes (the decision
// task, or the attempt it retries), is pending, then runs for `duration` minutes
// and ends at last_modified with its final result.
function replay(final: JobsPage, pushTime: number) {
  const jobs = rows(final);
  const decisionEnd = utc(jobs.find((j) => j.job_type_name === "Gecko Decision Task")!.last_modified);
  const timeline = jobs.map((j) => {
    const end = utc(j.last_modified);
    let appear = decisionEnd;
    if (j.job_type_name === "Gecko Decision Task") {
      appear = pushTime;
    } else if (j.retry_id > 0) {
      appear = utc(jobs.find((p) => p.task_id === j.task_id && p.retry_id === j.retry_id - 1)!.last_modified);
    }
    return { j, appear, start: Math.max(appear, end - j.duration * 60_000), end };
  });
  return (now: number): JobsPage => ({
    next: null,
    job_property_names: final.job_property_names,
    results: timeline
      .filter((x) => now >= x.appear)
      .map((x) => {
        const j = { ...x.j };
        if (now < x.start) {
          Object.assign(j, { state: "pending", result: "unknown" });
        } else if (now < x.end) {
          Object.assign(j, { state: "running", result: "unknown" });
        }
        return final.job_property_names.map((n) => (j as unknown as Record<string, unknown>)[n]);
      }),
  });
}

test("watch --lando follows a real push from Lando to the last job", async () => {
  const push = json("push-d25e111ef965.json").results[0];
  const pushTime = push.push_timestamp * 1000;
  const world = fakeWorld({ landoLandsAt: pushTime - 60_000, pushAppearsAt: pushTime + 30_000, jobs: replay(json("jobs-d25e111ef965.json"), pushTime) });
  const finished = await watch({ landoJobId: 103624 }, world.deps, { intervalMs: 60_000 });

  const lines = world.lines.map((l) => l.line);
  assert.deepEqual(lines.slice(0, 3), [
    { type: "lando", landoJobId: 103624, status: "IN_PROGRESS" },
    { type: "lando", landoJobId: 103624, status: "LANDED" },
    { type: "pushed", rev: REV, pushId: 2065854, url: `https://treeherder.mozilla.org/jobs?repo=try&revision=${REV}` },
  ]);

  const failed = world.lines.filter((l) => l.line.type === "job-failed");
  assert.equal(failed.length, 1);
  assert.deepEqual(failed[0].line, {
    type: "job-failed",
    taskId: "UY09xRrXQv2Z_AmVqg9P5w",
    retryId: 0,
    jobId: 599293407,
    jobName: "test-windows10-64-2009-qr/debug-xpcshell",
    platform: "windows10-64-2009-qr/debug",
    result: "testfailed",
    tier: 2,
  });
  // Reported within a poll of the failure, long before the push ends.
  assert.ok(failed[0].t - utc("2026-10-12T21:26:26.151835") <= 60_000);
  assert.ok(utc("2026-10-12T22:07:31.998878") - failed[0].t > 30 * 60_000);

  const progress = lines.filter((l) => l.type === "progress");
  assert.ok(progress.length > 5);
  for (let i = 1; i < progress.length; i++) {
    assert.notDeepEqual(progress[i], progress[i - 1], "progress only on change");
  }
  assert.deepEqual(progress.at(-1), { type: "progress", done: 54, total: 54, failures: 1 });

  assert.deepEqual(lines.at(-1), finished);
  assert.equal(finished.result, "failures");
  assert.equal(finished.rev, REV);
  assert.equal(finished.total, 54);
  assert.equal(
    finished.summary,
    "54 jobs, 1 failed (1 retried): test-windows10-64-2009-qr/debug-xpcshell (testfailed).",
  );
  assert.equal(lines.filter((l) => l.type === "finished").length, 1);
  assert.ok(world.now() >= utc("2026-10-12T22:07:31.998878"));
});

test("watch <rev> on a finished green push ends after one poll", async () => {
  const final = json("jobs-d25e111ef965.json") as JobsPage;
  const green: JobsPage = {
    ...final,
    results: final.results.map((r) => r.map((v) => (v === "testfailed" ? "success" : v))),
  };
  const world = fakeWorld({ landoLandsAt: 0, pushAppearsAt: 0, jobs: () => green });
  const finished = await watch({ rev: REV }, world.deps);
  assert.equal(finished.result, "green");
  assert.equal(finished.summary, "54 jobs, all green (1 retried).");
  assert.deepEqual(
    world.lines.map((l) => l.line.type),
    ["pushed", "progress", "finished"],
  );
});

test("watch survives transient fetch errors", async () => {
  const world = fakeWorld({ landoLandsAt: 0, pushAppearsAt: 0, jobs: () => json("jobs-d25e111ef965.json"), failures: new Set([0, 2, 3]) });
  const finished = await watch({ rev: REV }, world.deps, { intervalMs: 1000 });
  assert.equal(finished.result, "failures");
});

test("watch gives up after too many consecutive errors, or on timeout", async () => {
  const failing = fakeWorld({ landoLandsAt: 0, pushAppearsAt: 0, jobs: () => json("jobs-d25e111ef965.json"), failures: new Set([0, 1, 2]) });
  await assert.rejects(watch({ rev: REV }, failing.deps, { maxConsecutiveErrors: 3 }), /ECONNRESET/);
  const never = fakeWorld({ landoLandsAt: 0, pushAppearsAt: Infinity, jobs: () => json("jobs-d25e111ef965.json") });
  await assert.rejects(watch({ rev: REV }, never.deps, { timeoutMs: 3600_000 }), /timed out after 60 min waiting for push/);
});

test("watch --lando fails when the Lando job failed", async () => {
  const deps: WatchDeps = {
    now: () => 0,
    sleep: async () => {},
    emit: () => {},
    fetch: async () => response(json("lando-failed.json")),
  };
  await assert.rejects(watch({ landoJobId: 103529 }, deps), /Lando job 103529 failed: Aborting, could not apply patch/);
});

test("watch --lando refuses a Lando job that isn't a try push", async () => {
  const deps: WatchDeps = {
    now: () => 0,
    sleep: async () => {},
    emit: () => {},
    fetch: async () => response({ ...json("lando-landed.json"), repository: "firefox-autoland" }),
  };
  await assert.rejects(watch({ landoJobId: 103624 }, deps), /lands to firefox-autoland/);
});

test("pushStatus: a running push is not complete", () => {
  const s = pushStatus(rows(json("jobs-running.json")));
  assert.deepEqual([s.done, s.total, s.failures, s.complete], [7, 66, 0, false]);
});

test("pushStatus: only the decision task done is not the end", () => {
  const jobs = rows(json("jobs-d25e111ef965.json")).filter((j) => j.job_type_name === "Gecko Decision Task");
  assert.equal(pushStatus(jobs).complete, false);
  assert.equal(pushStatus([{ ...jobs[0], result: "busted" }]).complete, true);
});

test("fetchJobs follows pagination", async () => {
  const pages: Record<string, string> = {
    "https://treeherder.mozilla.org/api/jobs/?push_id=2067066&count=300": "jobs-c4a4cfd245f2-page1.json",
    "https://treeherder.mozilla.org/api/jobs/?count=300&page=2&push_id=2067066": "jobs-c4a4cfd245f2-page2.json",
    "https://treeherder.mozilla.org/api/jobs/?count=300&page=3&push_id=2067066": "jobs-c4a4cfd245f2-page3.json",
  };
  const deps: WatchDeps = { now: () => 0, sleep: async () => {}, emit: () => {}, fetch: async (url) => response(json(pages[url])) };
  const jobs = await fetchJobs(deps, 2067066, 300);
  assert.equal(jobs.length, 761);
  assert.equal(new Set(jobs.map((j) => j.id)).size, 761);
  const s = pushStatus(jobs);
  assert.deepEqual([s.done, s.failures, s.complete], [761, 37, true]);
});

test("parsePushOutput finds the Lando job", () => {
  assert.deepEqual(parsePushOutput(text("push-output.txt")), {
    landoJobId: 103624,
    treeherderUrl: "https://treeherder.mozilla.org/jobs?repo=try&landoInstance=lando-prod-2025&landoCommitID=103624",
  });
  assert.throws(() => parsePushOutput("abort: error submitting patches to Lando.\n"), /no Lando job/);
});

test("push refuses under --dry-run", async () => {
  let ran = false;
  const r = await push("/wt", ["fuzzy", "-q", "x"], {
    dryRun: true,
    run: async () => {
      ran = true;
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.deepEqual(r, { dryRun: true, command: ["./mach", "try", "fuzzy", "-q", "x"], cwd: "/wt" });
  assert.equal(ran, false);
});

test("push waits for Lando to land the push and returns its revision", async () => {
  const world = fakeWorld({ landoLandsAt: 120_000, pushAppearsAt: 0, jobs: () => json("jobs-d25e111ef965.json") });
  const commands: string[][] = [];
  const r = await push("/wt", ["fuzzy", "-q", "x"], {
    dryRun: false,
    deps: world.deps,
    run: async (cmd) => {
      commands.push(cmd);
      return { code: 0, stdout: text("push-output.txt"), stderr: "" };
    },
  });
  assert.deepEqual(commands, [["./mach", "try", "fuzzy", "-q", "x"]]);
  assert.deepEqual(r, {
    landoJobId: 103624,
    landoUrl: "https://lando.moz.tools/landings/103624",
    treeherderUrl: `https://treeherder.mozilla.org/jobs?repo=try&revision=${REV}`,
    rev: REV,
  });
});

test("push returns without a revision when Lando is slow", async () => {
  const world = fakeWorld({ landoLandsAt: 1e15, pushAppearsAt: 0, jobs: () => json("jobs-d25e111ef965.json") });
  const r = await push("/wt", ["fuzzy", "-q", "x"], {
    dryRun: false,
    deps: world.deps,
    landoTimeoutMs: 60_000,
    run: async () => ({ code: 0, stdout: text("push-output.txt"), stderr: "" }),
  });
  assert.ok(!("dryRun" in r) && !("rev" in r));
  assert.equal(r.treeherderUrl, "https://treeherder.mozilla.org/jobs?repo=try&landoInstance=lando-prod-2025&landoCommitID=103624");
});
