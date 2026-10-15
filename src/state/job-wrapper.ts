// node src/state/job-wrapper.ts <jobDir>
//
// Started detached by startJob (src/state/jobs.ts). Runs spec.cmd in spec.cwd with
// spec.env added to its own environment, stdin from spec.stdinFile (or /dev/null),
// stdout to out.log, stderr to err.log, and writes exit.json {exitCode, endedAt,
// signal?} when the command ends. A signal that kills the command is reported as
// exitCode 128 + its number, like a shell does.
// SIGTERM, SIGINT and SIGHUP sent to the wrapper are forwarded to the command, and
// exit.json is still written once it ends.
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, openSync, readFileSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import type { JobSpec } from "./jobs.ts";
import { writeFileAtomic } from "./jsonl.ts";

const jobDir = process.argv[2];
if (!jobDir) {
  process.stderr.write("usage: job-wrapper.ts <jobDir>\n");
  process.exit(2);
}

const errPath = join(jobDir, "err.log");
let done = false;

function finish(exitCode: number, signal?: string): never {
  if (!done) {
    done = true;
    writeFileAtomic(join(jobDir, "exit.json"), JSON.stringify({ exitCode, endedAt: new Date().toISOString(), ...(signal ? { signal } : {}) }) + "\n");
  }
  process.exit(exitCode);
}

// Installed before spawning: the command can start (and a canceller see its output)
// before spawn() returns, and a SIGTERM arriving then would kill the wrapper outright.
// Handlers run from the event loop, so after the synchronous spawn below.
let child: ChildProcess | undefined;
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(sig, () => {
    child?.kill(sig);
  });
}

try {
  const spec = JSON.parse(readFileSync(join(jobDir, "spec.json"), "utf8")) as JobSpec;
  const stdin = spec.stdinFile ? openSync(spec.stdinFile, "r") : "ignore";
  const out = openSync(join(jobDir, "out.log"), "a");
  const err = openSync(errPath, "a");
  child = spawn(spec.cmd[0], spec.cmd.slice(1), {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: [stdin, out, err],
  });
  child.on("error", (e) => {
    appendFileSync(errPath, `job-wrapper: cannot run ${JSON.stringify(spec.cmd)} in ${spec.cwd}: ${e.message}\n`);
    finish(127);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      finish(128 + constants.signals[signal], signal);
    }
    finish(code ?? 1);
  });
} catch (e) {
  appendFileSync(errPath, `job-wrapper: ${e instanceof Error ? e.message : String(e)}\n`);
  finish(1);
}
