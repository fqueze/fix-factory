import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { UsageError } from "../lib/cli.ts";
import type { ExecResult } from "../lib/exec.ts";
import {
  checkTryArgs,
  dryRun,
  INGESTION_DELAY_MS,
  fetchJobs,
  findDuplicate,
  parseDryRunOutput,
  parsePushOutput,
  push,
  expectedTests,
  pushStatus,
  testProgress,
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
    if (cmd[0] === "timeout") {
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
  assert.throws(() => checkTryArgs(["fuzzy", "-q", "x", "--pernosco"]), /--pernosco/);
  assert.throws(() => checkTryArgs(["fuzzy", "-q", "x", "--push-to"]), /--push-to is not allowed/, "argparse abbreviation");
  assert.throws(() => checkTryArgs(["fuzzy", "-q", "x", "--stage"]), /--stage is not allowed/);
  assert.throws(() => checkTryArgs(["fuzzy", "-q", "x", "--no-p=1"]), /--no-p=1 is not allowed/);
  assert.throws(() => checkTryArgs(["fuzzy", "-q", "x", "--", "xpcom/tests/unit"]), /"--" is not allowed/);
  assert.throws(() => checkTryArgs(["fuzzy", "xpcom/tests/unit"]), /needs -q/);
  assert.throws(() => checkTryArgs(["fuzzy", "-q", "x", "-xi"]), /-xi is not allowed/);
  assert.throws(() => checkTryArgs(["again", "--purge"]), /--purge/);
  assert.throws(() => checkTryArgs(["chooser"]), /must be a selector/);
  assert.throws(() => checkTryArgs(["-q", "x"]), /must be a selector/);
  assert.throws(() => checkTryArgs([]), /missing/);
  assert.throws(() => checkTryArgs(["fuzzy"]), UsageError);
  checkTryArgs(["fuzzy", "-q", "'xpcshell 'linux2404-64/opt", "--rebuild", "5", "--no-artifact", "--no-pernosco", "xpcom/tests/unit"]);
  checkTryArgs(["fuzzy", "--query='xpcshell", "--preset", "x"]);
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
  assert.equal(p.taskCount, 18);
  assert.deepEqual(p.warnings, []);
  assert.equal(p.tryTaskConfig["use-artifact-builds"], true);
});

test("parseDryRunOutput: per-label rebuild and chemspill priority", () => {
  const out = text("dry-run-rebuild.txt").replace('"rebuild": 3,', '"priority": "low", "rebuild": {"test-linux2404-64/opt-xpcshell-1": 5},');
  const p = parseDryRunOutput(out);
  assert.equal(p.taskCount, 5 + 5);
  assert.deepEqual(p.warnings, ["--chemspill-priority needs the user's permission, for this push only."]);
});

test("parseDryRunOutput: large push prompt", () => {
  const p = parseDryRunOutput(text("dry-run-large-push.txt"));
  assert.equal(p.taskCount, p.tasks.length * 2);
  assert.deepEqual(p.warnings, ["Large push (at least 2580 tasks): it will run at the lowest priority."]);
});

test("parseDryRunOutput: no tasks selected", () => {
  assert.throws(() => parseDryRunOutput(text("dry-run-no-tasks.txt")), /no tasks/);
});

test("dryRun puts --no-push right after the selector and reports the stack", async () => {
  const { run, calls } = fakeExec(text("dry-run-rebuild.txt"));
  const args = ["fuzzy", "-q", "'xpcshell 'linux2404-64/opt", "--rebuild", "3", "--artifact", "xpcom/tests/unit"];
  const r = await dryRun("/wt", args, { exec: run });
  assert.deepEqual(calls[0].cmd, ["timeout", "--kill-after=30", "1200", "./mach", "try", "fuzzy", "--no-push", "-q", "'xpcshell 'linux2404-64/opt", "--rebuild", "3", "--artifact", "xpcom/tests/unit"]);
  assert.equal(calls[0].input, "y\n");
  assert.deepEqual(r.command, ["./mach", "try", ...args]);
  assert.equal(r.taskCount, 18);
  assert.equal(r.tryTaskConfig.rebuild, 3);
  assert.deepEqual(r.commits, COMMITS);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.duplicateOf, undefined);
});

test("dryRun never runs mach with a -- in the arguments", async () => {
  const { run, calls } = fakeExec(text("dry-run-rebuild.txt"));
  await assert.rejects(dryRun("/wt", ["fuzzy", "-q", "x", "--", "xpcom/tests/unit"], { exec: run }), /"--" is not allowed/);
  assert.deepEqual(calls, []);
});

test("dryRun warns about an artifact push of native changes", async () => {
  const { run } = fakeExec(text("dry-run-rebuild.txt"), "xpcom/io/nsLocalFileUnix.cpp\nxpcom/tests/unit/test_x.js\n");
  const r = await dryRun("/wt", ["fuzzy", "-q", "x", "--artifact"], { exec: run });
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /nsLocalFileUnix\.cpp.*--no-artifact/);
});

test("dryRun reports a duplicate of a pending push", async () => {
  const { run } = fakeExec(text("dry-run-rebuild.txt"));
  const config = parseDryRunOutput(text("dry-run-rebuild.txt")).tryTaskConfig;
  // Same config with its keys in another order.
  const reordered = Object.fromEntries(Object.entries(config).reverse());
  const pending = [
    { push: "p1", tryTaskConfig: config, commits: ["other"] },
    { push: "p2", tryTaskConfig: reordered, commits: COMMITS },
  ];
  const r = await dryRun("/wt", ["fuzzy", "-q", "x"], { exec: run, pending });
  assert.equal(r.duplicateOf, "p2");
  assert.match(r.warnings.at(-1)!, /pending push p2/);

  const differs = (change: Record<string, unknown>) => findDuplicate({ tryTaskConfig: { ...config, ...change }, commits: COMMITS }, pending);
  assert.equal(differs({}), "p2");
  assert.equal(differs({ rebuild: 5 }), undefined);
  assert.equal(differs({ "use-artifact-builds": false }), undefined, "--no-artifact push for product code");
  assert.equal(differs({ env: { TRY_SELECTOR: "fuzzy", MOZHARNESS_TEST_PATHS: '{"xpcshell": ["xpcom/tests/unit"]}' } }), undefined);
  assert.equal(findDuplicate({ tryTaskConfig: config, commits: COMMITS }, [{ tryTaskConfig: config, commits: COMMITS }]), "0");
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

test("pushStatus: only the decision task done is not the end, for a while", () => {
  const jobs = rows(json("jobs-d25e111ef965.json")).filter((j) => j.job_type_name === "Gecko Decision Task");
  const decisionEnd = utc(jobs[0].last_modified);
  assert.equal(pushStatus(jobs, decisionEnd + 60_000).complete, false);
  assert.equal(pushStatus(jobs, decisionEnd + 20 * 60_000).complete, true, "scheduled nothing");
  assert.equal(pushStatus([{ ...jobs[0], result: "busted" }], decisionEnd).complete, true);
});

test("pushStatus: not complete while a retried task's replacement hasn't shown up", () => {
  const jobs = rows(json("jobs-c4a4cfd245f2-page1.json"))
    .concat(rows(json("jobs-c4a4cfd245f2-page2.json")))
    .concat(rows(json("jobs-c4a4cfd245f2-page3.json")));
  assert.equal(pushStatus(jobs).complete, true);
  const retried = jobs.find((j) => j.result === "retry")!;
  const withoutReplacement = jobs.filter((j) => !(j.task_id === retried.task_id && j.retry_id > retried.retry_id));
  assert.equal(withoutReplacement.length, jobs.length - 1);
  assert.equal(pushStatus(withoutReplacement).complete, false);
});

test("watch finishes when the only jobs left are unscheduled behind a failure", async () => {
  // The macOS build's second attempt busted, so its tests never get scheduled.
  const final = json("jobs-d25e111ef965.json") as JobsPage;
  const names = final.job_property_names;
  const col = (n: string) => names.indexOf(n);
  const busted: JobsPage = {
    ...final,
    results: final.results.map((r) => {
      const row = [...r];
      if (row[col("job_type_name")] === "build-macosx64/opt" && row[col("retry_id")] === 1) {
        row[col("result")] = "busted";
      } else if (String(row[col("platform")]).startsWith("macosx")) {
        row[col("state")] = "unscheduled";
        row[col("result")] = "unknown";
      }
      return row;
    }),
  };
  const notRun = rows(busted).filter((j) => j.state === "unscheduled");
  assert.ok(notRun.length > 0);

  const world = fakeWorld({ landoLandsAt: 0, pushAppearsAt: 0, jobs: () => busted });
  const finished = await watch({ rev: REV }, world.deps, { intervalMs: 60_000 });
  assert.deepEqual(finished.notRun, notRun.map((j) => j.job_type_name));
  assert.equal(finished.failures, 2);
  assert.match(finished.summary, new RegExp(`\\(1 retried, ${notRun.length} not run\\)`));
  // One poll to see it, one to confirm it.
  assert.deepEqual(
    world.lines.map((l) => l.line.type),
    ["pushed", "job-failed", "job-failed", "progress", "finished"],
  );
  // The push appears at 0, then the confirming poll is one interval later.
  assert.equal(world.now(), 60_000);
});

test("watch: unscheduled jobs without a failure finish after 15 min without change", async () => {
  // As if a build's dependency had been cancelled: its dependents never get scheduled.
  const final = json("jobs-d25e111ef965.json") as JobsPage;
  const names = final.job_property_names;
  const jobs: JobsPage = {
    ...final,
    results: final.results.map((r, i) => {
      const row = r.map((v) => (v === "testfailed" ? "success" : v));
      if (i === 5) {
        row[names.indexOf("state")] = "unscheduled";
        row[names.indexOf("result")] = "unknown";
      }
      return row;
    }),
  };
  const world = fakeWorld({ landoLandsAt: 0, pushAppearsAt: 0, jobs: () => jobs });
  const finished = await watch({ rev: REV }, world.deps, { intervalMs: 60_000 });
  assert.equal(world.now(), INGESTION_DELAY_MS);
  assert.equal(finished.result, "failures");
  assert.deepEqual(finished.notRun, [rows(jobs)[5].job_type_name]);
  assert.equal(finished.summary, "54 jobs, none failed but some never ran (1 retried, 1 not run).");
});

test("watch: a decision task that scheduled nothing isn't green", async () => {
  const final = json("jobs-d25e111ef965.json") as JobsPage;
  const decision = { ...final, results: final.results.filter((r) => r[final.job_property_names.indexOf("job_type_name")] === "Gecko Decision Task") };
  const decisionEnd = utc(rows(decision)[0].last_modified);
  const world = fakeWorld({ landoLandsAt: decisionEnd + 5 * 60_000, pushAppearsAt: 0, jobs: () => decision });
  const finished = await watch({ rev: REV }, world.deps, { intervalMs: 60_000 });
  assert.equal(world.now(), decisionEnd + INGESTION_DELAY_MS);
  assert.equal(finished.result, "failures");
  assert.equal(finished.summary, "The decision task scheduled nothing: no test ran.");
});

test("dryRun reports a mach that hangs", async () => {
  const run = async (): Promise<ExecResult> => ({ code: 124, stdout: "Would you like to proceed anyway? [Y/n]: ", stderr: "" });
  await assert.rejects(dryRun("/wt", ["fuzzy", "-q", "x"], { exec: run, timeoutS: 5 }), /timed out after 5 s/);
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
  assert.throws(() => parsePushOutput("abort: error submitting patches to Lando.\n"), /no Lando job; the push may have been submitted, do not retry/);
});

test("CLI push honours dryRun from the config", () => {
  const dir = mkdtempSync(join(tmpdir(), "try-test-"));
  try {
    const config = join(dir, "factory.config.json");
    writeFileSync(config, JSON.stringify({ dryRun: true }));
    // A cwd that doesn't exist: if dryRun were ignored, mach couldn't even start.
    const r = spawnSync(process.execPath, [fileURLToPath(new URL("./try.ts", import.meta.url)), "push", "--cwd", join(dir, "nowhere"), "--", "fuzzy", "-q", "x"], {
      env: { ...process.env, FACTORY_CONFIG: config },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { dryRun: true, command: ["./mach", "try", "fuzzy", "-q", "x"], cwd: join(dir, "nowhere") });
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("CLI usage errors exit with 2", () => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("./try.ts", import.meta.url)), "dry-run", "--", "fuzzy", "-q", "x"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(JSON.parse(r.stdout).error, /--cwd/);
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

test("push refuses a stack that differs from the approved dry run's commits", async () => {
  let ran = false;
  const opts = (stack: string) => ({
    dryRun: false,
    expectCommits: ["bbb", "aaa"],
    exec: async () => ({ code: 0, stdout: stack, stderr: "" }),
    run: async () => {
      ran = true;
      return { code: 1, stdout: "", stderr: "stop here" };
    },
  });
  await assert.rejects(push("/wt", ["fuzzy", "-q", "x"], opts("ccc\naaa\n")), /^Error: not pushed: commits changed since the approved dry run: expected bbb,aaa, found ccc,aaa/);
  assert.equal(ran, false);
  await assert.rejects(push("/wt", ["fuzzy", "-q", "x"], opts("bbb\naaa\n")), /mach try exited with 1/);
  assert.equal(ran, true);
});

test("push refuses approved commits it can't check out, and pushes nothing", async () => {
  const calls: string[] = [];
  let ran = false;
  const exec = async (cmd: string[]) => {
    calls.push(cmd.slice(1).join(" "));
    if (cmd[1] === "symbolic-ref") return { code: 0, stdout: "other-branch\n", stderr: "" };
    if (cmd[1] === "checkout") return { code: 1, stdout: "", stderr: "fatal: reference is not a tree: bbb" };
    return { code: 0, stdout: "bbb\naaa\n", stderr: "" };
  };
  await assert.rejects(
    push("/wt", ["fuzzy", "-q", "x"], { dryRun: false, expectCommits: ["bbb", "aaa"], exec, run: async () => ((ran = true), { code: 0, stdout: "", stderr: "" }) }),
    /^Error: not pushed: commits changed since the approved dry run: can't check out bbb: fatal: reference is not a tree/,
  );
  assert.equal(ran, false);
  assert.deepEqual(calls.filter((c) => c.startsWith("checkout")), ["checkout --quiet --detach bbb"]);
});

test("push says when it can't put the worktree back", async () => {
  const exec = async (cmd: string[]) => {
    if (cmd[1] === "symbolic-ref") return { code: 0, stdout: "other-branch\n", stderr: "" };
    if (cmd[1] === "checkout") return cmd.includes("--detach") ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "error: local changes" };
    return { code: 0, stdout: "bbb\naaa\n", stderr: "" };
  };
  await assert.rejects(
    push("/wt", ["fuzzy", "-q", "x"], { dryRun: false, expectCommits: ["bbb", "aaa"], exec, run: async () => ({ code: 1, stdout: "", stderr: "stop here" }) }),
    /mach try exited with 1: stop here; the worktree couldn't be put back on other-branch: error: local changes/,
  );
});

test("push checks out the approved commits for the push, then puts the worktree back", async () => {
  const calls: string[] = [];
  let head = "other-branch";
  const exec = async (cmd: string[]) => {
    calls.push(cmd.slice(1).join(" "));
    if (cmd[1] === "symbolic-ref") return { code: 0, stdout: `${head}\n`, stderr: "" };
    if (cmd[1] === "checkout") head = cmd.at(-1)!;
    if (cmd[1] === "rev-list") return { code: 0, stdout: head === "bbb" ? "bbb\naaa\n" : "ccc\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  let pushedFrom = "";
  await assert.rejects(
    push("/wt", ["fuzzy", "-q", "x"], { dryRun: false, expectCommits: ["bbb", "aaa"], exec, run: async () => ((pushedFrom = head), { code: 1, stdout: "", stderr: "stop here" }) }),
    /mach try exited with 1/,
  );
  assert.equal(pushedFrom, "bbb");
  assert.equal(head, "other-branch");
  assert.deepEqual(calls.filter((c) => c.startsWith("checkout")), ["checkout --quiet --detach bbb", "checkout --quiet other-branch"]);
});

const thJob = (name: string, state: string, result: string, retryId = 0) =>
  ({ id: 1, job_type_name: name, platform: "linux", platform_option: "opt", result, state, tier: 1, task_id: "T", retry_id: retryId, last_modified: "", duration: 0 }) as TreeherderJob;

test("testProgress: finished runs of the expected tasks, retries not counted, capped at their runs", () => {
  const jobs = [
    thJob("a", "completed", "success"),
    thJob("a", "completed", "retry"),
    thJob("a", "completed", "testfailed", 1),
    thJob("a", "completed", "success"),
    thJob("b", "running", "unknown"),
    thJob("b", "completed", "success"),
    thJob("build", "completed", "success"),
  ];
  assert.deepEqual(testProgress(jobs, { a: 2, b: 3 }), { done: 3, total: 5 });
});

test("expectedTests: the dry run's test tasks with their runs, builds excluded", () => {
  const job = (label: string, build?: string) => ({ label, platform: "linux", collection: "opt", group: "", symbol: "X", tier: 1, ...(build ? { build } : {}) });
  const jobs = [job("build-linux/opt"), job("test-linux/opt-xpcshell-1", "build-linux/opt"), job("test-linux/opt-xpcshell-2", "build-linux/opt"), job("test-linux/opt-mochitest", "build-linux/opt")];
  const d = { command: [], taskCount: 4, tasks: [], commits: [], warnings: [], jobs };
  assert.equal(expectedTests({ ...d, tryTaskConfig: {}, jobs: undefined }), undefined);
  assert.deepEqual(expectedTests({ ...d, tryTaskConfig: {} }), { "test-linux/opt-xpcshell-1": 1, "test-linux/opt-xpcshell-2": 1, "test-linux/opt-mochitest": 1 });
  assert.deepEqual(expectedTests({ ...d, tryTaskConfig: { rebuild: 3 } }), { "test-linux/opt-xpcshell-1": 3, "test-linux/opt-xpcshell-2": 3, "test-linux/opt-mochitest": 3 });
  assert.deepEqual(expectedTests({ ...d, tryTaskConfig: { rebuild: { "test-linux/opt-xpcshell-*": 5, "test-linux/opt-xpcshell-2": 7 } } }), {
    "test-linux/opt-xpcshell-1": 5,
    "test-linux/opt-xpcshell-2": 7,
    "test-linux/opt-mochitest": 1,
  });
});
