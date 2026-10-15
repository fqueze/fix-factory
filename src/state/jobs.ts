// Detached jobs: jobs/<jobId>/{spec.json, pid.json, out.log, err.log, exit.json}.
//
// startJob spawns src/state/job-wrapper.ts in its own process group (setsid), with no
// stdio connected to the caller, so the job outlives the orchestrator. pid.json holds
// {pid, pidStartTime} of the wrapper, which is the process group leader.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ItemId, Iso, JobId, JobKind, RequestId } from "../types.ts";
import { checkId, writeFileAtomic } from "./jsonl.ts";

export interface JobSpec {
  cmd: string[];
  cwd: string;
  env?: Record<string, string>; // added to the orchestrator's environment
  stdinFile?: string; // absolute path used as the command's stdin; /dev/null when absent
  kind: JobKind;
  name: string;
  request?: RequestId;
  item?: ItemId;
}

export interface StartedJob {
  job: JobId;
  pid: number;
  pidStartTime: number;
}

export interface ExitInfo {
  exitCode: number;
  endedAt: Iso;
  signal?: string;
  cancelled?: boolean;
}

export type JobStatus = { state: "running" } | ({ state: "finished" } & ExitInfo) | { state: "lost" };

const WRAPPER = join(import.meta.dirname, "job-wrapper.ts");

export function jobDir(stateDir: string, jobId: JobId): string {
  checkId(jobId, "job id");
  return join(stateDir, "jobs", jobId);
}

export function newJobId(): JobId {
  const t = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `j-${t}-${randomBytes(3).toString("hex")}`;
}

export function startJob(stateDir: string, spec: JobSpec, opts: { job?: JobId } = {}): StartedJob {
  if (spec.cmd.length === 0) {
    throw new Error("startJob: empty cmd");
  }
  const job = opts.job ?? newJobId();
  const dir = jobDir(stateDir, job);
  mkdirSync(join(stateDir, "jobs"), { recursive: true });
  mkdirSync(dir); // fails if the job id was already used
  writeFileSync(join(dir, "spec.json"), JSON.stringify(spec, null, 2) + "\n");
  const child = spawn(process.execPath, [WRAPPER, dir], { detached: true, stdio: "ignore", cwd: dir });
  child.on("error", () => {
    // Reported below through the missing pid; without a listener the error would crash the caller.
  });
  if (child.pid === undefined) {
    throw new Error(`startJob: could not spawn the job wrapper for ${job}`);
  }
  child.unref();
  const pid = child.pid;
  const pidStartTime = readPidStartTime(pid);
  if (pidStartTime === null) {
    // The wrapper can't have finished already: it hasn't had time to even load.
    throw new Error(`startJob: wrapper ${pid} for ${job} vanished right after spawn`);
  }
  writeFileAtomic(join(dir, "pid.json"), JSON.stringify({ pid, pidStartTime }) + "\n");
  return { job, pid, pidStartTime };
}

// Field 22 of /proc/<pid>/stat (clock ticks since boot); null if there's no such process.
export function readPidStartTime(pid: number): number | null {
  return readStat(pid)?.startTime ?? null;
}

function readStat(pid: number): { state: string; startTime: number } | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  // The command name (field 2) is in parentheses and may contain spaces or ")".
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return { state: fields[0], startTime: Number(fields[19]) };
}

// Same pid and same start time, so not a reused pid. A zombie is not alive: it has exited.
export function isAlive(pid: number, pidStartTime: number): boolean {
  const s = readStat(pid);
  return s !== null && s.state !== "Z" && s.state !== "X" && s.startTime === pidStartTime;
}

export function readExit(stateDir: string, jobId: JobId): ExitInfo | null {
  try {
    return JSON.parse(readFileSync(join(jobDir(stateDir, jobId), "exit.json"), "utf8")) as ExitInfo;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw e;
  }
}

export function readPidFile(stateDir: string, jobId: JobId): { pid: number; pidStartTime: number } | null {
  const path = join(jobDir(stateDir, jobId), "pid.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { pid: number; pidStartTime: number }) : null;
}

// proc defaults to pid.json; pass the pid from the job-started event to use that instead.
export function jobStatus(stateDir: string, jobId: JobId, proc?: { pid: number; pidStartTime: number }): JobStatus {
  // exit.json first: it is written before the wrapper exits, so there is no window
  // where the job looks lost.
  const exit = readExit(stateDir, jobId);
  if (exit) {
    return { state: "finished", ...exit };
  }
  const p = proc ?? readPidFile(stateDir, jobId);
  if (p && isAlive(p.pid, p.pidStartTime)) {
    return { state: "running" };
  }
  // The wrapper may have written exit.json between the two checks.
  const late = readExit(stateDir, jobId);
  return late ? { state: "finished", ...late } : { state: "lost" };
}

// SIGTERM to the job's process group; SIGKILL after graceMs if it's still there. A
// SIGKILL also kills the wrapper, so exit.json is written here in that case.
export async function cancelJob(stateDir: string, jobId: JobId, opts: { graceMs?: number } = {}): Promise<JobStatus> {
  const p = readPidFile(stateDir, jobId);
  if (!p || !isAlive(p.pid, p.pidStartTime)) {
    return jobStatus(stateDir, jobId);
  }
  killGroup(p.pid, "SIGTERM");
  const deadline = Date.now() + (opts.graceMs ?? 5000);
  while (isAlive(p.pid, p.pidStartTime) && Date.now() < deadline) {
    await sleep(50);
  }
  if (isAlive(p.pid, p.pidStartTime)) {
    killGroup(p.pid, "SIGKILL");
    while (isAlive(p.pid, p.pidStartTime)) {
      await sleep(20);
    }
  }
  if (!readExit(stateDir, jobId)) {
    const exit: ExitInfo = { exitCode: 137, endedAt: new Date().toISOString(), signal: "SIGKILL", cancelled: true };
    writeFileAtomic(join(jobDir(stateDir, jobId), "exit.json"), JSON.stringify(exit) + "\n");
  }
  return jobStatus(stateDir, jobId);
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// For orchestrator startup: the status of every job the folded state says is running
// (job-started without job-finished). Finished ones need a job-finished event, lost
// ones a decision (usually retry).
export function reconcile(
  stateDir: string,
  runningJobs: readonly { job: JobId; pid: number; pidStartTime: number }[],
): { job: JobId; status: JobStatus }[] {
  return runningJobs.map((j) => ({ job: j.job, status: jobStatus(stateDir, j.job, j) }));
}
