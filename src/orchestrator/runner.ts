// Starts planned jobs and records finished ones. The side-effecting half of the orchestrator:
// writes the plan's files, renders prompts, starts the detached job, and turns its output into
// events (src/orchestrator/handlers.ts says what they mean).
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendFeedback, buildAgentCommand, parseStreamJson, promptVersion, renderPrompt, validateReport, type JsonSchema } from "../agents/run.ts";
import { appendCommand } from "../state/commands.ts";
import type { EventInput } from "../state/events.ts";
import { appendEventSafe } from "./event-data.ts";
import { jobDir, newJobId, startJob, type ExitInfo } from "../state/jobs.ts";
import type { FactoryConfig, Feedback, JobId, RequestState } from "../types.ts";
import { handleFinished, handleWatchLines, InvalidReport } from "./handlers.ts";
import { reportPath, type JobPlan } from "./plan.ts";
import type { JobRecord, View } from "./view.ts";

export interface RunnerDeps {
  config: FactoryConfig;
  configPath: string; // passed to every job as FACTORY_CONFIG: the CLIs read it from wherever they run
  factoryRoot: string; // prompts/, schemas/, src/cli/
  codeVersion: string;
  cliCommand: (tool: string) => string[]; // the command prefix of a CLI; tests replace it with fixtures
}

export function defaultCliCommand(factoryRoot: string): (tool: string) => string[] {
  return (tool) => (tool.endsWith(".ts") ? [process.execPath, join(factoryRoot, "src", "cli", tool)] : [tool]);
}

function writeFiles(files: readonly { path: string; content: string }[]): void {
  for (const f of files) {
    mkdirSync(dirname(f.path), { recursive: true });
    writeFileSync(f.path, f.content);
  }
}

// Under the 4 KB line limit: the event's cmd is for people, spec.json has the real one.
function displayCmd(cmd: string[]): string[] {
  const out: string[] = [];
  let size = 0;
  for (let i = 0; i < cmd.length; i++) {
    const arg = cmd[i - 1] === "--json-schema" ? "<schema>" : cmd[i].length > 300 ? `${cmd[i].slice(0, 300)}…` : cmd[i];
    size += arg.length + 3;
    if (size > 1500) {
      out.push(`… ${cmd.length - i} more`);
      break;
    }
    out.push(arg);
  }
  return out;
}

export function startPlan(deps: RunnerDeps, request: string, plan: JobPlan): JobId {
  const { config } = deps;
  const job = newJobId();
  writeFiles(plan.files ?? []);
  let cmd: string[];
  let stdinFile: string | undefined;
  // plan.json: what retry-job runs again, through the same path (dry run included).
  const jobFiles: Record<string, string> = { "plan.json": JSON.stringify(plan, null, 2) + "\n" };
  let model: string | undefined;
  let version: string | undefined;
  if (plan.agent) {
    const index = JSON.parse(readFileSync(join(deps.factoryRoot, "prompts", "index.json"), "utf8")) as Record<string, { model: string }>;
    model = index[plan.name].model;
    const promptFile = join(deps.factoryRoot, "prompts", `${plan.name}.md`);
    version = promptVersion(promptFile);
    const text = plan.agent.vars ? renderPrompt(readFileSync(promptFile, "utf8"), plan.agent.vars) : plan.agent.message!;
    jobFiles["prompt.md"] = text;
    stdinFile = join(jobDir(config.stateDir, job), "prompt.md");
    const schema = readFileSync(join(deps.factoryRoot, "schemas", `${plan.name}.json`), "utf8");
    // Its report is checked against the schema it was given, even if schemas/ changes meanwhile.
    jobFiles["schema.json"] = schema;
    cmd = buildAgentCommand(config, plan.agent.resume ? { model, schema, resume: plan.agent.sessionId } : { model, schema, sessionId: plan.agent.sessionId });
  } else if (plan.cli) {
    cmd = [...deps.cliCommand(plan.cli.tool), ...plan.cli.args];
  } else {
    cmd = plan.cmd!;
  }
  const started = startJob(
    config.stateDir,
    { cmd, cwd: plan.cwd, env: { FACTORY_CONFIG: deps.configPath }, ...(stdinFile ? { stdinFile } : {}), kind: plan.kind, name: plan.name, request, ...(plan.item ? { item: plan.item } : {}) },
    { job, files: jobFiles },
  );
  appendEventSafe(config.stateDir, {
    type: "job-started",
    request,
    job,
    ...(plan.item ? { item: plan.item } : {}),
    kind: plan.kind,
    name: plan.name,
    pid: started.pid,
    pidStartTime: started.pidStartTime,
    cmd: displayCmd(cmd),
    cwd: plan.cwd,
    codeVersion: deps.codeVersion,
    ...(model ? { model, sessionId: plan.agent!.sessionId, promptVersion: version } : {}),
    purpose: plan.purpose,
  });
  for (const e of plan.startEvents ?? []) appendEventSafe(config.stateDir, e);
  return job;
}

export function readOut(config: Pick<FactoryConfig, "stateDir">, job: JobId): string {
  try {
    return readFileSync(join(jobDir(config.stateDir, job), "out.log"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
}

function errTail(config: FactoryConfig, job: JobId): string {
  try {
    return readFileSync(join(jobDir(config.stateDir, job), "err.log"), "utf8").trim().split("\n").slice(-3).join(" / ").slice(-500);
  } catch (e) {
    // A lost job may have died before the wrapper opened its logs.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
}

export function readReport(config: Pick<FactoryConfig, "stateDir">, request: string, job: JobId): unknown {
  return JSON.parse(readFileSync(reportPath(config, request, job), "utf8"));
}

// Records a finished job: its meaning as events (successful ones only), then job-finished.
// The derived events go first, so a crash in between replays them rather than losing them.
export function finishJob(deps: RunnerDeps, s: RequestState, view: View, rec: JobRecord, exit: ExitInfo | { exitCode: number; endedAt: string; error: string }): void {
  const { config } = deps;
  const out = readOut(config, rec.job);
  const durationMs = Math.max(0, Date.parse(exit.endedAt) - rec.startedAt);
  const append = (events: EventInput[]) => events.forEach((e) => appendEventSafe(config.stateDir, e));
  let error = "error" in exit ? exit.error : undefined;
  let costUsd: number | undefined;
  // first: events recorded only when the handler accepts the result (an agent's report).
  const handle = (report?: unknown, first: EventInput[] = []) => {
    try {
      const r = handleFinished({ state: s, view, config, job: rec, output: out, report, reportOf: (job) => readReport(config, s.id, job), outputOf: (job) => readOut(config, job) });
      writeFiles(r.files ?? []);
      append([...first, ...r.events]);
      // Their ids derive from the job, so a replay after a crash executes them once.
      for (const c of r.commands ?? []) appendCommand(config.stateDir, c);
    } catch (e) {
      // An output we can't make sense of fails this job, not the loop.
      error = (e instanceof InvalidReport ? `invalid report: ${e.message}` : `recording the result failed: ${e instanceof Error ? e.message : String(e)}`).slice(0, 1500);
    }
  };

  if (error === undefined && rec.kind === "agent") {
    const summary = parseStreamJson(out);
    // total_cost_usd is the session's: subtract the earlier runs of the same session.
    const earlier = Object.values(s.jobs).filter((j) => j.sessionId === rec.sessionId && j.job !== rec.job && j.costUsd !== undefined);
    if (summary.costUsd !== undefined) costUsd = Math.round((summary.costUsd - earlier.reduce((a, j) => a + j.costUsd!, 0)) * 1e6) / 1e6;
    if (!summary.done) error = `no result line (exit code ${exit.exitCode})${errTail(config, rec.job) ? `: ${errTail(config, rec.job)}` : ""}`;
    else if (summary.isError) error = `claude reported an error: ${(summary.resultText ?? "").slice(0, 300)}`;
    else {
      // Jobs started before schema.json was saved have only the current one.
      const saved = join(jobDir(config.stateDir, rec.job), "schema.json");
      const schema = JSON.parse(readFileSync(existsSync(saved) ? saved : join(deps.factoryRoot, "schemas", `${rec.name}.json`), "utf8")) as JsonSchema;
      const problems = summary.report === undefined ? ["$: no structured_output"] : validateReport(schema, summary.report);
      if (problems.length > 0) error = `invalid report: ${problems.join("; ")}`.slice(0, 1500);
    }
    if (error === undefined) {
      const report = summary.report as { feedback: Feedback[] };
      const path = reportPath(config, s.id, rec.job);
      writeFiles([{ path, content: JSON.stringify(report, null, 2) + "\n" }]);
      appendFeedback(config.stateDir, rec.job, report.feedback);
      handle(report, [{ type: "agent-report", request: s.id, job: rec.job, ...(rec.item ? { item: rec.item } : {}), prompt: rec.name, report }]);
    }
  } else if (error === undefined) {
    if (rec.kind === "try-watch") append(handleWatchLines(s, view, rec.purpose.push!, jsonLines(out).lines));
    if (exit.exitCode !== 0) {
      error = cliError(out) ?? (errTail(config, rec.job) || `exit code ${exit.exitCode}`);
    } else if (rec.kind !== "try-watch") {
      // CLIs print one JSON document; the other script jobs print text.
      if (/\.ts\b/.test(rec.name)) {
        try {
          JSON.parse(out);
        } catch {
          error = `unparsable output: ${out.slice(0, 200)}`;
        }
      }
      if (error === undefined) handle();
    }
  }
  const machProfiles = rec.kind === "agent" ? 0 : keepMachProfiles(config, rec.job, out);
  appendEventSafe(config.stateDir, {
    type: "job-finished",
    request: s.id,
    job: rec.job,
    exitCode: exit.exitCode,
    durationMs,
    ...(machProfiles ? { machProfiles } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(error !== undefined ? { error } : {}),
  });
}

// mach builds and test runs name the resource-usage profile they write ("Streaming resource usage profile
// to: <path>"). Copies go in the job's directory, as mach-profile-<n>.json: the objdir's can be replaced
// or removed with its worktree.
function keepMachProfiles(config: FactoryConfig, job: JobId, out: string): number {
  const errFile = join(jobDir(config.stateDir, job), "err.log");
  const text = `${existsSync(errFile) ? readFileSync(errFile, "utf8") : ""}\n${out}`;
  const paths = [...new Set([...text.matchAll(/Streaming resource usage profile to: (\S+\.json)/g)].map((m) => m[1]))].filter((p) => existsSync(p));
  paths.forEach((p, n) => copyFileSync(p, join(jobDir(config.stateDir, job), `mach-profile-${n + 1}.json`)));
  return paths.length;
}

function cliError(out: string): string | undefined {
  try {
    const o = JSON.parse(out.trim().split("\n").at(-1) ?? "") as { error?: unknown };
    return typeof o.error === "string" ? o.error.slice(0, 1000) : undefined;
  } catch {
    return undefined;
  }
}

// Complete JSON lines after a byte offset, for try.ts watch output read as it arrives.
export function jsonLines(text: string, fromChar = 0): { lines: unknown[]; next: number } {
  const lines: unknown[] = [];
  let start = fromChar;
  for (let nl = text.indexOf("\n", start); nl !== -1; nl = text.indexOf("\n", start)) {
    const line = text.slice(start, nl).trim();
    start = nl + 1;
    if (!line) continue;
    try {
      lines.push(JSON.parse(line));
    } catch {
      // Not a watch line (a log line on stdout): nothing to record.
    }
  }
  return { lines, next: start };
}
