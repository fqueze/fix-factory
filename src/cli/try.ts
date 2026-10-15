// try.ts: plan, push and watch try pushes. Every subcommand that touches the
// Firefox tree takes the worktree with --cwd.
//
// node src/cli/try.ts dry-run --cwd <worktree> [--pending <file>] -- <mach try args...>
//   Runs `./mach try <args> --no-push` and prints
//   {command: string[], taskCount: number, tasks: string[], rebuild: number,
//    commits: string[], warnings: string[], duplicateOf?: string}
//   command is the push command (without --no-push). tasks are the labels from
//   try_task_config.json, possibly chunk patterns ending in "*" (see warnings).
//   taskCount = tasks × rebuild. commits are the stack's shas, newest first.
//   --pending is a JSON list of PendingPush ({push?, tasks, commits, taskCount?});
//   duplicateOf is set (to `push`, or the list index) when one has the same task
//   set and the same commits.
//
// node src/cli/try.ts push --cwd <worktree> [--lando-timeout <s>] -- <mach try args...>
//   Under --dry-run, or when the config has dryRun, refuses and prints
//   {dryRun: true, command, cwd}. Otherwise runs `./mach try <args>` and prints
//   {landoJobId, landoUrl, treeherderUrl, rev?}. rev is missing when Lando hasn't
//   landed the push within --lando-timeout seconds (default 600); `watch --lando`
//   resolves it later. If Lando needs an Auth0 login, a line
//   "lando-login-required: <url>" goes to stderr and mach waits for the login.
//
// node src/cli/try.ts watch <rev> | --lando <jobId> [--interval <s>] [--timeout <min>]
//   Polls Lando (with --lando) until the job has landed, then Treeherder until the
//   push exists and every job is complete. Prints JSON lines (WatchLine):
//   {type: "lando", landoJobId, status}                       on each status change
//   {type: "pushed", rev, pushId, url}                         once the push exists
//   {type: "job-failed", taskId, retryId, jobId, jobName, platform, result, tier}
//                                                              once per failed job, as it appears
//   {type: "progress", done, total, failures}                 when a count changes
//   {type: "finished", result: "green" | "failures", summary, rev, done, total, failures}
//   A Lando job that failed or was cancelled ends with {"error": ...} and exit 1.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleepMs } from "node:timers/promises";
import { loadConfig } from "../config.ts";
import { log, runCli } from "../lib/cli.ts";
import { exec, type ExecResult } from "../lib/exec.ts";

export const TREEHERDER = "https://treeherder.mozilla.org";
// The Lando instance mach uses by default (section lando-prod-new of .lando.ini).
export const LANDO = "https://lando.moz.tools";
const USER_AGENT = "fix-factory (try.ts)";

// ---------------------------------------------------------------------------
// mach try arguments

const REJECTED_FLAGS: Record<string, string> = {
  "--no-push": "dry-run adds --no-push itself, and push must push",
  "--stage-changes": "it only stages changes, it never pushes",
  "--push-to-vcs": "it bypasses Lando, and the factory follows pushes through their Lando job",
  "--closed-tree": "the factory never pushes on a closed tree",
  "--save": "it saves a preset instead of pushing",
  "--list-presets": "it lists presets instead of pushing",
  "--edit-presets": "it edits presets instead of pushing",
  "--interactive": "nobody is there to answer",
  "-i": "nobody is there to answer",
};

// The others are interactive (chooser, perf), push more than once (compare) or
// aren't about tests (release, scriptworker).
const SELECTORS = new Set(["fuzzy", "auto", "again", "empty"]);
const FUZZY_QUERY_FLAGS = ["-q", "--query", "-x", "--and", "--preset"];

export function checkTryArgs(args: string[]): void {
  if (args.length === 0) {
    throw new Error("missing mach try arguments after --");
  }
  for (const arg of args) {
    const flag = arg.split("=")[0];
    if (flag in REJECTED_FLAGS) {
      throw new Error(`${flag} is not allowed: ${REJECTED_FLAGS[flag]}`);
    }
  }
  const selector = args[0];
  if (!selector.startsWith("-") && !SELECTORS.has(selector)) {
    throw new Error(`unsupported selector ${selector}; use one of ${[...SELECTORS].join(", ")}`);
  }
  // Without a query, fuzzy opens fzf and waits for keystrokes forever.
  if (selector === "fuzzy" && !args.some((a) => FUZZY_QUERY_FLAGS.includes(a.split("=")[0]))) {
    throw new Error("mach try fuzzy needs -q (or --preset): without it, it opens fzf interactively");
  }
}

// ---------------------------------------------------------------------------
// dry-run

export interface PendingPush {
  push?: string;
  tasks: string[];
  commits: string[];
  taskCount?: number;
}

export interface DryRunResult {
  command: string[];
  taskCount: number;
  tasks: string[];
  rebuild: number;
  commits: string[];
  warnings: string[];
  duplicateOf?: string;
}

export interface ParsedDryRun {
  tasks: string[];
  rebuild: number;
  taskCount: number;
  tryTaskConfig: Record<string, unknown>;
  warnings: string[];
}

const CONFIG_MARKER = "Calculated try_task_config.json:";

export function parseDryRunOutput(stdout: string): ParsedDryRun {
  if (/^no tasks selected$/m.test(stdout)) {
    throw new Error("mach try selected no tasks");
  }
  const at = stdout.indexOf(CONFIG_MARKER);
  if (at === -1) {
    throw new Error(`no try_task_config.json in mach try output: ${stdout.trim().slice(-1000)}`);
  }
  const config = JSON.parse(stdout.slice(at + CONFIG_MARKER.length)) as { parameters?: { try_task_config?: Record<string, unknown> } };
  const tryTaskConfig = config.parameters?.try_task_config ?? {};
  const tasks = (tryTaskConfig.tasks as string[] | undefined) ?? [];
  const rebuildValue = tryTaskConfig.rebuild as number | Record<string, number> | undefined;
  let taskCount: number;
  let rebuild = 1;
  if (typeof rebuildValue === "object") {
    taskCount = tasks.reduce((n, t) => n + (rebuildValue[t] ?? 1), 0);
  } else {
    rebuild = rebuildValue ?? 1;
    taskCount = tasks.length * rebuild;
  }

  const warnings: string[] = [];
  const patterns = tasks.filter((t) => t.includes("*"));
  if (patterns.length > 0) {
    warnings.push(
      `${patterns.length} of ${tasks.length} labels are chunk patterns (e.g. ${patterns[0]}), so the real task count is higher than ${taskCount}. ` +
        "Add --show-chunk-numbers for exact labels.",
    );
  }
  const large = /Your push would schedule at least (\d+) tasks/.exec(stdout);
  if (large) {
    warnings.push(`Large push (at least ${large[1]} tasks): it will run at the lowest priority.`);
  }
  return { tasks, rebuild, taskCount, tryTaskConfig, warnings };
}

// Same as mach's base_ref: commits of HEAD that no remote has.
export async function stackCommits(cwd: string, run = exec): Promise<string[]> {
  const out = await runOk(run, ["git", "rev-list", "HEAD", "--not", "--remotes"], cwd);
  return out.split("\n").filter(Boolean);
}

const NATIVE_FILE = /\.(c|cc|cpp|cxx|h|hh|hpp|m|mm|rs|idl|webidl)$|(^|\/)Cargo\.(toml|lock)$/;

async function nativeFiles(cwd: string, run: typeof exec): Promise<string[]> {
  const out = await runOk(run, ["git", "log", "--name-only", "--format=", "HEAD", "--not", "--remotes"], cwd);
  return [...new Set(out.split("\n").filter((f) => NATIVE_FILE.test(f)))];
}

export function findDuplicate(result: { tasks: string[]; commits: string[]; taskCount: number }, pending: PendingPush[]): string | undefined {
  const tasks = [...result.tasks].sort().join("\n");
  const commits = result.commits.join("\n");
  const index = pending.findIndex(
    (p) =>
      [...p.tasks].sort().join("\n") === tasks &&
      p.commits.join("\n") === commits &&
      (p.taskCount === undefined || p.taskCount === result.taskCount),
  );
  return index === -1 ? undefined : (pending[index].push ?? String(index));
}

export async function dryRun(cwd: string, args: string[], opts: { pending?: PendingPush[]; exec?: typeof exec } = {}): Promise<DryRunResult> {
  checkTryArgs(args);
  const run = opts.exec ?? exec;
  const command = ["./mach", "try", ...args];
  // "y" answers the large push prompt, which otherwise crashes on EOF.
  const r = await run([...command, "--no-push"], { cwd, input: "y\n" });
  if (r.code !== 0) {
    throw new Error(`mach try --no-push exited with ${r.code}: ${(r.stdout + r.stderr).trim().slice(-2000)}`);
  }
  const parsed = parseDryRunOutput(r.stdout);
  const commits = await stackCommits(cwd, run);
  const warnings = [...parsed.warnings];
  if (commits.length === 0) {
    warnings.push("The stack has no commits that aren't on a remote: the push would only carry the try config.");
  }
  if (parsed.tryTaskConfig["use-artifact-builds"]) {
    const native = await nativeFiles(cwd, run);
    if (native.length > 0) {
      warnings.push(
        `Artifact push, but the stack changes native code (${native.slice(0, 5).join(", ")}${native.length > 5 ? ", …" : ""}): ` +
          "it would test trunk's binaries. Pass --no-artifact.",
      );
    }
  }
  if (args.some((a) => a === "--chemspill" || a === "--chemspill-priority")) {
    warnings.push("--chemspill-priority needs the user's permission, for this push only.");
  }
  const result: DryRunResult = {
    command,
    taskCount: parsed.taskCount,
    tasks: parsed.tasks,
    rebuild: parsed.rebuild,
    commits,
    warnings,
  };
  const duplicateOf = opts.pending ? findDuplicate(result, opts.pending) : undefined;
  if (duplicateOf !== undefined) {
    result.duplicateOf = duplicateOf;
    result.warnings.push(`Same tasks and commits as pending push ${duplicateOf}.`);
  }
  return result;
}

async function runOk(run: typeof exec, cmd: string[], cwd: string): Promise<string> {
  const r = await run(cmd, { cwd });
  if (r.code !== 0) {
    throw new Error(`${cmd.join(" ")} exited with ${r.code}: ${r.stderr.trim().slice(-2000)}`);
  }
  return r.stdout;
}

// ---------------------------------------------------------------------------
// push

export interface PushResult {
  landoJobId: number;
  landoUrl: string;
  treeherderUrl: string;
  rev?: string;
}

export interface ParsedPush {
  landoJobId: number;
  treeherderUrl: string;
}

// mach prints "try submission success in 12.3s:\n https://treeherder.mozilla.org/jobs?repo=try&landoInstance=lando-prod-2025&landoCommitID=12345"
// (tools/tryselect/push.py, TREEHERDER_LANDO_TRY_RUN_URL).
export function parsePushOutput(stdout: string): ParsedPush {
  const url = /https:\/\/treeherder\.mozilla\.org\/jobs\?\S*landoCommitID=(\d+)\S*/.exec(stdout);
  if (!url) {
    throw new Error(`mach try printed no Lando job: ${stdout.trim().slice(-2000)}`);
  }
  return { landoJobId: Number(url[1]), treeherderUrl: url[0] };
}

// Streams the output to stderr, so it shows up in the job's err.log as it happens.
function runStreaming(cmd: string[], cwd: string, input: string, onLine: (line: string) => void): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0], cmd.slice(1), { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let partial = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      stdout += d;
      process.stderr.write(d);
      const lines = (partial + d).split("\n");
      partial = lines.pop() ?? "";
      lines.forEach(onLine);
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      stderr += d;
      process.stderr.write(d);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });
}

export async function push(
  cwd: string,
  args: string[],
  opts: { dryRun: boolean; landoTimeoutMs?: number; deps?: Partial<WatchDeps>; run?: typeof runStreaming },
): Promise<PushResult | { dryRun: true; command: string[]; cwd: string }> {
  checkTryArgs(args);
  const command = ["./mach", "try", ...args];
  if (opts.dryRun) {
    return { dryRun: true, command, cwd };
  }
  const run = opts.run ?? runStreaming;
  // "y" answers the large push prompt; the dry run already warned about it.
  const r = await run(command, cwd, "y\n", (line) => {
    const login = /navigate to: (\S+)/.exec(line);
    if (login) {
      log(`lando-login-required: ${login[1]}`);
    }
  });
  if (r.code !== 0) {
    throw new Error(`mach try exited with ${r.code}: ${(r.stdout + r.stderr).trim().slice(-2000)}`);
  }
  const { landoJobId, treeherderUrl } = parsePushOutput(r.stdout);
  const result: PushResult = { landoJobId, landoUrl: `${LANDO}/landings/${landoJobId}`, treeherderUrl };
  const deps = { ...defaultDeps(), ...opts.deps };
  try {
    result.rev = await waitForLando(landoJobId, deps, { intervalMs: 10_000, timeoutMs: opts.landoTimeoutMs ?? 600_000 });
    result.treeherderUrl = treeherderPushUrl(result.rev);
  } catch (e) {
    if (e instanceof LandoJobError) {
      throw e;
    }
    // The push itself succeeded; watch --lando can still find the revision.
    log(`no revision for Lando job ${landoJobId} yet: ${e instanceof Error ? e.message : e}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Lando and Treeherder

export interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export interface WatchDeps {
  fetch: (url: string) => Promise<FetchResponse>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  emit: (line: WatchLine) => void;
}

export function defaultDeps(): WatchDeps {
  return {
    fetch: (url) => fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } }),
    sleep: (ms) => sleepMs(ms),
    now: () => Date.now(),
    emit: (line) => process.stdout.write(JSON.stringify(line) + "\n"),
  };
}

async function getJson<T>(deps: WatchDeps, url: string): Promise<T> {
  const r = await deps.fetch(url);
  if (!r.ok) {
    throw new Error(`GET ${url}: HTTP ${r.status}`);
  }
  return (await r.json()) as T;
}

// GET /landing_jobs/<id>/ is public. status goes SUBMITTED → IN_PROGRESS → LANDED
// (or DEFERRED, FAILED, CANCELLED); once LANDED, commit_id is the try revision.
export interface LandoJob {
  id: number;
  status: string;
  commit_id: string;
  error: string;
  repository: string;
}

export class LandoJobError extends Error {}

export function fetchLandoJob(deps: WatchDeps, id: number): Promise<LandoJob> {
  return getJson<LandoJob>(deps, `${LANDO}/landing_jobs/${id}/`);
}

export interface TreeherderPush {
  id: number;
  revision: string;
  author: string;
  push_timestamp: number;
}

export async function fetchPush(deps: WatchDeps, rev: string): Promise<TreeherderPush | undefined> {
  const r = await getJson<{ results: TreeherderPush[] }>(deps, `${TREEHERDER}/api/project/try/push/?revision=${rev}`);
  return r.results[0];
}

export interface TreeherderJob {
  id: number;
  job_type_name: string;
  platform: string;
  platform_option: string;
  result: string;
  state: string; // unscheduled, pending, running, completed
  tier: number;
  task_id: string;
  retry_id: number;
  last_modified: string;
  duration: number;
}

interface JobsPage {
  next: string | null;
  results: unknown[][];
  job_property_names: string[];
}

export async function fetchJobs(deps: WatchDeps, pushId: number, pageSize = 2000): Promise<TreeherderJob[]> {
  const jobs: TreeherderJob[] = [];
  let url: string | null = `${TREEHERDER}/api/jobs/?push_id=${pushId}&count=${pageSize}`;
  while (url) {
    const page: JobsPage = await getJson<JobsPage>(deps, url);
    for (const row of page.results) {
      jobs.push(Object.fromEntries(page.job_property_names.map((name, i) => [name, row[i]])) as unknown as TreeherderJob);
    }
    url = page.next;
  }
  return jobs;
}

export function treeherderPushUrl(rev: string): string {
  return `${TREEHERDER}/jobs?repo=try&revision=${rev}`;
}

// ---------------------------------------------------------------------------
// watch

export type WatchLine =
  | { type: "lando"; landoJobId: number; status: string }
  | { type: "pushed"; rev: string; pushId: number; url: string }
  | { type: "progress"; done: number; total: number; failures: number }
  | { type: "job-failed"; taskId: string; retryId: number; jobId: number; jobName: string; platform: string; result: string; tier: number }
  | WatchFinished;

export interface WatchFinished {
  type: "finished";
  result: "green" | "failures";
  summary: string;
  rev: string;
  done: number;
  total: number;
  failures: number;
}

export interface WatchOptions {
  intervalMs?: number;
  timeoutMs?: number;
  pageSize?: number;
  maxConsecutiveErrors?: number;
}

const FAILED_RESULTS = new Set(["testfailed", "busted", "exception"]);
const DECISION_TASK = "Gecko Decision Task";

export interface PushStatus {
  done: number;
  total: number;
  failures: number;
  failed: TreeherderJob[];
  complete: boolean;
}

export function pushStatus(jobs: TreeherderJob[]): PushStatus {
  const completed = jobs.filter((j) => j.state === "completed");
  const failed = completed.filter((j) => FAILED_RESULTS.has(j.result));
  const decision = jobs.filter((j) => j.job_type_name === DECISION_TASK);
  const decisionDone = decision.length > 0 && decision.every((j) => j.state === "completed");
  const decisionFailed = decision.some((j) => FAILED_RESULTS.has(j.result));
  // Right after the decision task completes, Treeherder may not have ingested the
  // tasks it scheduled yet: "all complete" with only the decision task isn't the end.
  const hasOtherJobs = jobs.some((j) => j.job_type_name !== DECISION_TASK);
  return {
    done: completed.length,
    total: jobs.length,
    failures: failed.length,
    failed,
    complete: completed.length === jobs.length && decisionDone && (hasOtherJobs || decisionFailed),
  };
}

export function summarize(jobs: TreeherderJob[], status = pushStatus(jobs)): string {
  const retried = jobs.filter((j) => j.result === "retry").length;
  const cancelled = jobs.filter((j) => j.result === "usercancel").length;
  const extras = [retried && `${retried} retried`, cancelled && `${cancelled} cancelled`].filter(Boolean).join(", ");
  const tail = extras ? ` (${extras})` : "";
  if (status.failures === 0) {
    return `${status.total} jobs, all green${tail}.`;
  }
  const names = status.failed.map((j) => `${j.job_type_name} (${j.result})`);
  const shown = names.slice(0, 10).join(", ") + (names.length > 10 ? `, and ${names.length - 10} more` : "");
  return `${status.total} jobs, ${status.failures} failed${tail}: ${shown}.`;
}

// Calls fn until it succeeds, sleeping between attempts; transient errors are only
// logged, so a Treeherder hiccup doesn't kill a watch that has run for hours.
class Poller {
  private errors = 0;
  private start: number;
  private deps: WatchDeps;
  private intervalMs: number;
  private timeoutMs: number;
  private maxErrors: number;

  constructor(deps: WatchDeps, intervalMs: number, timeoutMs: number, maxErrors: number) {
    this.deps = deps;
    this.intervalMs = intervalMs;
    this.timeoutMs = timeoutMs;
    this.maxErrors = maxErrors;
    this.start = deps.now();
  }

  async attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      const r = await fn();
      this.errors = 0;
      return r;
    } catch (e) {
      if (e instanceof LandoJobError || ++this.errors >= this.maxErrors) {
        throw e;
      }
      log(`poll failed (${this.errors}/${this.maxErrors}): ${e instanceof Error ? e.message : e}`);
      return undefined;
    }
  }

  async wait(what: string): Promise<void> {
    if (this.deps.now() - this.start + this.intervalMs > this.timeoutMs) {
      throw new Error(`timed out after ${Math.round(this.timeoutMs / 60_000)} min waiting for ${what}`);
    }
    await this.deps.sleep(this.intervalMs);
  }
}

export async function waitForLando(
  jobId: number,
  deps: WatchDeps,
  opts: { intervalMs: number; timeoutMs: number; maxConsecutiveErrors?: number; onStatus?: (status: string) => void },
): Promise<string> {
  const poller = new Poller(deps, opts.intervalMs, opts.timeoutMs, opts.maxConsecutiveErrors ?? 10);
  let last: string | undefined;
  for (;;) {
    const job = await poller.attempt(() => fetchLandoJob(deps, jobId));
    if (job) {
      if (job.repository !== "try") {
        throw new LandoJobError(`Lando job ${jobId} lands to ${job.repository}, it isn't a try push`);
      }
      if (job.status !== last) {
        last = job.status;
        opts.onStatus?.(job.status);
      }
      if (job.status === "LANDED" && job.commit_id) {
        return job.commit_id;
      }
      if (job.status === "FAILED" || job.status === "CANCELLED") {
        throw new LandoJobError(`Lando job ${jobId} ${job.status.toLowerCase()}${job.error ? `: ${job.error.slice(0, 1000)}` : ""}`);
      }
    }
    await poller.wait(`Lando job ${jobId}`);
  }
}

export async function watch(target: { rev: string } | { landoJobId: number }, deps: WatchDeps, opts: WatchOptions = {}): Promise<WatchFinished> {
  const intervalMs = opts.intervalMs ?? 60_000;
  const timeoutMs = opts.timeoutMs ?? 48 * 3600_000;
  const maxErrors = opts.maxConsecutiveErrors ?? 10;
  const poller = new Poller(deps, intervalMs, timeoutMs, maxErrors);

  let rev: string;
  if ("rev" in target) {
    rev = target.rev;
  } else {
    const landoJobId = target.landoJobId;
    rev = await waitForLando(landoJobId, deps, {
      intervalMs,
      timeoutMs,
      maxConsecutiveErrors: maxErrors,
      onStatus: (status) => deps.emit({ type: "lando", landoJobId, status }),
    });
  }

  let push: TreeherderPush | undefined;
  for (;;) {
    push = await poller.attempt(() => fetchPush(deps, rev));
    if (push) {
      break;
    }
    await poller.wait(`push ${rev} on Treeherder`);
  }
  rev = push.revision;
  deps.emit({ type: "pushed", rev, pushId: push.id, url: treeherderPushUrl(rev) });

  const reported = new Set<number>();
  let lastProgress = "";
  for (;;) {
    const jobs = await poller.attempt(() => fetchJobs(deps, push.id, opts.pageSize));
    if (jobs) {
      const status = pushStatus(jobs);
      for (const j of status.failed) {
        if (!reported.has(j.id)) {
          reported.add(j.id);
          deps.emit({
            type: "job-failed",
            taskId: j.task_id,
            retryId: j.retry_id,
            jobId: j.id,
            jobName: j.job_type_name,
            platform: `${j.platform}/${j.platform_option}`,
            result: j.result,
            tier: j.tier,
          });
        }
      }
      const progress = `${status.done}/${status.total}/${status.failures}`;
      if (progress !== lastProgress) {
        lastProgress = progress;
        deps.emit({ type: "progress", done: status.done, total: status.total, failures: status.failures });
      }
      if (status.complete) {
        const finished: WatchFinished = {
          type: "finished",
          result: status.failures === 0 ? "green" : "failures",
          summary: summarize(jobs, status),
          rev,
          done: status.done,
          total: status.total,
          failures: status.failures,
        };
        deps.emit(finished);
        return finished;
      }
    }
    await poller.wait(`push ${rev} to complete`);
  }
}

// ---------------------------------------------------------------------------
// CLI

function requireCwd(values: Record<string, unknown>): string {
  if (typeof values.cwd !== "string") {
    throw new Error("--cwd <firefox worktree> is required");
  }
  return values.cwd;
}

function positiveNumber(value: unknown, name: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const n = Number(value);
  if (!(n > 0)) {
    throw new Error(`${name} must be a positive number`);
  }
  return n;
}

async function main(): Promise<void> {
  await runCli(
    {
      "dry-run": async (args, values) => {
        const pending = typeof values.pending === "string" ? (JSON.parse(readFileSync(values.pending, "utf8")) as PendingPush[]) : undefined;
        return dryRun(requireCwd(values), args, { pending });
      },
      push: async (args, values) => {
        const cwd = requireCwd(values);
        const isDryRun = values["dry-run"] === true || loadConfig().dryRun;
        return push(cwd, args, {
          dryRun: isDryRun,
          landoTimeoutMs: positiveNumber(values["lando-timeout"], "--lando-timeout", 600) * 1000,
        });
      },
      watch: async (args, values) => {
        const intervalMs = positiveNumber(values.interval, "--interval", 60) * 1000;
        const timeoutMs = positiveNumber(values.timeout, "--timeout", 48 * 60) * 60_000;
        let target: { rev: string } | { landoJobId: number };
        if (typeof values.lando === "string") {
          target = { landoJobId: positiveNumber(values.lando, "--lando", 0) };
        } else if (args[0] && /^[0-9a-f]{12,40}$/.test(args[0])) {
          target = { rev: args[0] };
        } else {
          throw new Error("usage: watch <rev> | --lando <jobId>");
        }
        await watch(target, defaultDeps(), { intervalMs, timeoutMs });
        // The JSON lines were the output.
        return undefined;
      },
    },
    {
      cwd: { type: "string" },
      pending: { type: "string" },
      "lando-timeout": { type: "string" },
      lando: { type: "string" },
      interval: { type: "string" },
      timeout: { type: "string" },
    },
  );
}

if (import.meta.main) {
  await main();
}
