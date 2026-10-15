import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { cancelJob, isAlive, jobDir, jobStatus, readExit, readPidStartTime, reconcile, startJob, type JobSpec, type JobStatus } from "./jobs.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ff-jobs-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const spec = (cmd: string[], extra: Partial<JobSpec> = {}): JobSpec => ({ cmd, cwd: dir, kind: "script", name: "test", ...extra });

async function waitFor(jobId: string, timeoutMs = 10_000): Promise<JobStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = jobStatus(dir, jobId);
    if (s.state !== "running") return s;
    if (Date.now() > deadline) throw new Error(`job ${jobId} still running after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const log = (jobId: string, name: string) => readFileSync(join(jobDir(dir, jobId), name), "utf8");

test("readPidStartTime and isAlive", () => {
  const start = readPidStartTime(process.pid);
  assert.equal(typeof start, "number");
  assert.ok(isAlive(process.pid, start!));
  assert.equal(isAlive(process.pid, start! + 1), false);
  assert.equal(readPidStartTime(2 ** 22 + 1), null);
});

test("a job's stdout, stderr, env and cwd, and its exit code", async () => {
  const { job, pid, pidStartTime } = startJob(dir, spec(["sh", "-c", 'echo "out $FOO $(pwd)"; echo err >&2'], { env: { FOO: "bar" } }));
  assert.ok(pid > 0 && pidStartTime > 0);
  const s = await waitFor(job);
  assert.equal(s.state, "finished");
  assert.equal(s.state === "finished" && s.exitCode, 0);
  assert.equal(log(job, "out.log"), `out bar ${dir}\n`);
  assert.equal(log(job, "err.log"), "err\n");
  assert.deepEqual(JSON.parse(log(job, "spec.json")).cmd[0], "sh");
  assert.match(readExit(dir, job)!.endedAt, /^\d{4}-/);
});

test("stdin comes from stdinFile, or /dev/null without it", async () => {
  const input = join(dir, "prompt.txt");
  writeFileSync(input, "x".repeat(200_000) + "\n");
  const withFile = startJob(dir, spec(["wc", "-c"], { stdinFile: input }));
  const without = startJob(dir, spec(["wc", "-c"]));
  await waitFor(withFile.job);
  await waitFor(without.job);
  assert.equal(log(withFile.job, "out.log").trim(), "200001");
  assert.equal(log(without.job, "out.log").trim(), "0");
});

test("a failing command and a missing command", async () => {
  const failing = startJob(dir, spec(["sh", "-c", "exit 3"]));
  const missing = startJob(dir, spec(["/nonexistent/command"]));
  const a = await waitFor(failing.job);
  const b = await waitFor(missing.job);
  assert.equal(a.state === "finished" && a.exitCode, 3);
  assert.equal(b.state === "finished" && b.exitCode, 127);
  assert.match(log(missing.job, "err.log"), /cannot run/);
});

test("a job id can't be reused", () => {
  startJob(dir, spec(["true"]), { job: "j-fixed" });
  assert.throws(() => startJob(dir, spec(["true"]), { job: "j-fixed" }), /EEXIST/);
});

test("the wrapper leads its own process group", async () => {
  const { job, pid } = startJob(dir, spec(["sleep", "5"]));
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const pgrp = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
    assert.equal(pgrp, pid);
    assert.equal(jobStatus(dir, job).state, "running");
  } finally {
    await cancelJob(dir, job, { graceMs: 2000 });
  }
});

test("cancelJob kills the process group and exit.json records the signal", async () => {
  const { job, pid, pidStartTime } = startJob(dir, spec(["sh", "-c", "sleep 30 & wait"]));
  await new Promise((r) => setTimeout(r, 200));
  const s = await cancelJob(dir, job, { graceMs: 3000 });
  assert.equal(s.state, "finished");
  assert.equal(s.state === "finished" && s.exitCode, 128 + 15);
  assert.equal(isAlive(pid, pidStartTime), false);
  // The grandchild (sleep) was in the same group, so it's gone too: no process left in the group.
  assert.throws(() => process.kill(-pid, 0), /ESRCH/);
});

test("cancelJob escalates to SIGKILL and still writes exit.json", async () => {
  const { job } = startJob(dir, spec(["sh", "-c", "trap '' TERM; sleep 30 & wait; sleep 30"]));
  await new Promise((r) => setTimeout(r, 200));
  const s = await cancelJob(dir, job, { graceMs: 300 });
  assert.equal(s.state, "finished");
  assert.equal(s.state === "finished" && s.exitCode, 137);
});

test("a job whose wrapper died without exit.json is lost; reconcile reports each job", async () => {
  const running = startJob(dir, spec(["sleep", "5"]));
  const done = startJob(dir, spec(["true"]));
  const lost = startJob(dir, spec(["sleep", "5"]));
  await waitFor(done.job);
  process.kill(-lost.pid, "SIGKILL");
  while (isAlive(lost.pid, lost.pidStartTime)) await new Promise((r) => setTimeout(r, 20));
  try {
    const r = reconcile(dir, [running, done, lost]);
    assert.deepEqual(
      r.map((x) => [x.job, x.status.state]),
      [
        [running.job, "running"],
        [done.job, "finished"],
        [lost.job, "lost"],
      ],
    );
    // A reused pid (different start time) counts as gone.
    assert.equal(reconcile(dir, [{ ...running, pidStartTime: running.pidStartTime + 1 }])[0].status.state, "lost");
  } finally {
    await cancelJob(dir, running.job, { graceMs: 2000 });
  }
});

test("a job survives its parent exiting", async () => {
  const parent = join(dir, "parent.ts");
  const jobsUrl = pathToFileURL(join(import.meta.dirname, "jobs.ts")).href;
  writeFileSync(
    parent,
    `import { startJob } from ${JSON.stringify(jobsUrl)};
const r = startJob(${JSON.stringify(dir)}, { cmd: ["sh", "-c", "sleep 0.5; echo survived"], cwd: ${JSON.stringify(dir)}, kind: "script", name: "orphan" });
console.log(JSON.stringify(r));
`,
  );
  const started = Date.now();
  // execFileSync returns once the parent exits and its stdout closes: it would hang
  // for the job's duration if the job had inherited the pipe.
  const { job, pid, pidStartTime } = JSON.parse(execFileSync(process.execPath, [parent], { encoding: "utf8" }));
  assert.ok(Date.now() - started < 5000);
  assert.equal(existsSync(join(jobDir(dir, job), "exit.json")), false, "parent should exit before the job ends");
  assert.ok(isAlive(pid, pidStartTime));
  const s = await waitFor(job);
  assert.equal(s.state === "finished" && s.exitCode, 0);
  assert.equal(log(job, "out.log"), "survived\n");
});
