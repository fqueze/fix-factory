// Firefox worktrees for agents: create (with a build) and remove. Port of the orchestrate-parallel-fixes
// skill's new-worktree.sh.
//
//   node src/cli/worktree.ts create <name> [--base <ref>] --build artifact|debug|full
//     → {name, path, branch, base, build, mozconfig, objdir, smokeLog}
//     Creates <config.worktreesDir>/<name> on branch <name> (off --base, default: the checkout's current
//     branch; an existing branch is checked out as is), writes its mozconfig, runs ./mach build and a sanity
//     mochitest. Long-running: meant to run as a job. Build output goes to stderr.
//     artifact: opt artifact build. debug: debug artifact build (still about a minute). full: debug build
//     compiled locally, for C++ changes.
//     A failed build leaves the worktree in place. Running create again with the same name reuses it (the
//     worktree at that path on branch <name>) and runs the build again, so a failed create can be retried.
//
//   node src/cli/worktree.ts remove <name>
//     → {name, path, killed: [{pid, cmdline}], removed: true}
//     Kills the processes whose command line names the worktree or whose working directory is in it (and
//     only those), then `git worktree remove --force`, which also deletes the in-tree objdir. The branch is
//     kept. killed lists the processes actually signalled.
//
// Worktrees live outside the checkout: worktrees inside it break `mach try`.

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { log, runCli, UsageError } from "../lib/cli.ts";
import { exec, execOk } from "../lib/exec.ts";
import { loadConfig } from "../config.ts";

export type BuildKind = "artifact" | "debug" | "full";

export function flavor(build: BuildKind): string {
  return { artifact: "opt-artifact", debug: "dbg-artifact", full: "dbg" }[build];
}

export function mozconfig(build: BuildKind): string {
  const lines = ["mk_add_options AUTOCLOBBER=1", `mk_add_options MOZ_OBJDIR=@TOPSRCDIR@/obj-${flavor(build)}`];
  if (build !== "artifact") lines.push("ac_add_options --enable-debug");
  if (build !== "full") lines.push("ac_add_options --enable-artifact-builds");
  return lines.join("\n") + "\n";
}

export function validateName(name: string): void {
  if (!name || name.includes("/") || name.startsWith("-") || name === "." || name === "..") {
    throw new Error(`invalid worktree name: ${name}`);
  }
}

// realpath of the longest existing prefix: worktreesDir may not exist yet.
function realOrResolved(path: string): string {
  const p = resolve(path);
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(realOrResolved(parent), basename(p));
  }
}

export function isInside(path: string, dir: string): boolean {
  const p = realOrResolved(path);
  const d = realOrResolved(dir);
  return p === d || p.startsWith(d + "/");
}

export function worktreeAddArgs(dest: string, name: string, base: string, branchExists: boolean): string[] {
  return branchExists ? ["worktree", "add", dest, name] : ["worktree", "add", "-b", name, dest, base];
}

// From `git worktree list --porcelain`: blocks of "worktree <path>", "HEAD <sha>", "branch refs/heads/<name>".
export function isWorktreeOn(porcelain: string, path: string, branch: string): boolean {
  return porcelain.split("\n\n").some((block) => {
    const lines = block.split("\n");
    return lines.includes(`worktree ${path}`) && lines.includes(`branch refs/heads/${branch}`);
  });
}

export const BUILD_COMMAND = ["./mach", "build"];
export const SMOKE_COMMAND = ["./mach", "mochitest", "--headless", "testing/mochitest/tests/Harness_sanity/test_sanity.html"];

// Like exec, but streams to a file descriptor instead of buffering: builds print a lot for a long time.
function run(cmd: string[], cwd: string, env: NodeJS.ProcessEnv, outFd: number): Promise<number> {
  return new Promise((res, rej) => {
    const child = spawn(cmd[0], cmd.slice(1), { cwd, env, stdio: ["ignore", outFd, outFd] });
    child.on("error", rej);
    child.on("close", (code) => res(code ?? 1));
  });
}

// A remote-tracking base (origin/main) is only as fresh as the last fetch: fetch it first. Worktrees created at
// the same time fetch at the same time, and git refuses to update a ref another fetch has locked: retry.
async function fetchRemoteBase(repo: string, base: string): Promise<void> {
  const ref = (await exec(["git", "rev-parse", "--symbolic-full-name", base], { cwd: repo })).stdout.trim();
  const m = /^refs\/remotes\/([^/]+)\/(.+)$/.exec(ref);
  if (!m) return;
  for (let attempt = 1; ; attempt++) {
    log(`git fetch ${m[1]} ${m[2]}`);
    const r = await exec(["git", "fetch", m[1], m[2]], { cwd: repo });
    if (r.code === 0) return;
    if (attempt === 3) throw new Error(`git fetch ${m[1]} ${m[2]}: ${r.stderr.trim()}`);
    await sleep(5000 * attempt);
  }
}

export async function create(name: string, opts: { base?: string; build: BuildKind; repo: string; worktreesDir: string }) {
  validateName(name);
  const { repo } = opts;
  if (!existsSync(join(repo, "mach"))) throw new Error(`${repo} is not a Firefox checkout`);
  if (isInside(opts.worktreesDir, repo)) throw new Error(`worktreesDir ${opts.worktreesDir} is inside ${repo}`);
  const dest = join(opts.worktreesDir, name);
  const git = (args: string[]) => execOk(["git", ...args], { cwd: repo });

  let base: string;
  if (existsSync(dest)) {
    // A retry after a failed build: reuse the tree if it's ours, on our branch.
    if (!isWorktreeOn(await git(["worktree", "list", "--porcelain"]), dest, name)) throw new Error(`${dest} already exists and isn't the worktree of branch ${name}`);
    base = opts.base ?? name;
    log(`reusing worktree ${dest}`);
  } else {
    const branchExists = (await exec(["git", "show-ref", "--verify", "--quiet", `refs/heads/${name}`], { cwd: repo })).code === 0;
    if (branchExists && opts.base) throw new Error(`branch ${name} already exists; --base would be ignored`);
    base = branchExists ? name : (opts.base ?? (await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim());
    if (!branchExists) await fetchRemoteBase(repo, base);
    mkdirSync(opts.worktreesDir, { recursive: true });
    log(`creating worktree ${dest} off ${base}`);
    await git(worktreeAddArgs(dest, name, base, branchExists));
  }

  const mozconfigPath = join(dest, "mozconfig");
  try {
    // mozconfig is untracked, so worktree add doesn't bring one across.
    writeFileSync(mozconfigPath, mozconfig(opts.build));
    mkdirSync(join(dest, "artifacts"), { recursive: true });
    // A stub, so a tree whose agent dies early still names itself.
    writeFileSync(join(dest, "artifacts/sessionlog.md"), `# ${name}\n\nWorktree \`${name}\`, branch \`${name}\`, off \`${base}\`.\n`);
  } catch (e) {
    await exec(["git", "worktree", "remove", "--force", dest], { cwd: repo });
    throw e;
  }

  // An inherited MOZCONFIG would win over the worktree's own mozconfig.
  const env = { ...process.env, MOZCONFIG: mozconfigPath };
  log(`./mach build (${flavor(opts.build)})`);
  const buildStatus = await run(BUILD_COMMAND, dest, env, 2);
  if (buildStatus !== 0) {
    throw new Error(`tree created at ${dest} but the build failed (exit ${buildStatus}); running create again reuses it and retries the build`);
  }

  // "Ready" means it can run a test, not that it compiled: a tree that builds and then can't run
  // mochitests costs an agent an hour.
  const smokeLog = join(dest, "artifacts/smoketest.log");
  const fd = openSync(smokeLog, "w");
  let smokeStatus: number;
  try {
    smokeStatus = await run(SMOKE_COMMAND, dest, env, fd);
  } finally {
    closeSync(fd);
  }
  if (smokeStatus !== 0) {
    // The log is overwritten by the next attempt: its end goes in this job's own log.
    process.stderr.write(`--- end of ${smokeLog} ---\n${readFileSync(smokeLog, "utf8").split("\n").slice(-200).join("\n")}\n`);
    throw new Error(`${dest} built but can't run a mochitest (the end of its log is in this job's stderr)`);
  }

  return { name, path: dest, branch: name, base, build: opts.build, mozconfig: mozconfigPath, objdir: join(dest, `obj-${flavor(opts.build)}`), smokeLog };
}

// True when the command line names the path itself or something under it, not a sibling such as
// "<path>-2" or "<path>+x".
export function mentionsPath(cmdline: string, path: string): boolean {
  for (let i = cmdline.indexOf(path); i !== -1; i = cmdline.indexOf(path, i + 1)) {
    const next = cmdline[i + path.length];
    if (next === undefined || next === "/" || /\s/.test(next)) return true;
  }
  return false;
}

export interface Proc {
  pid: number;
  cmdline: string;
}

// The working directory catches commands with relative paths, such as `python3 ./mach test`.
export function processesUnder(path: string, procRoot = "/proc", self = process.pid): Proc[] {
  const out: Proc[] = [];
  for (const entry of readdirSync(procRoot)) {
    if (!/^\d+$/.test(entry) || Number(entry) === self) continue;
    let raw: string;
    try {
      raw = readFileSync(join(procRoot, entry, "cmdline"), "utf8");
    } catch {
      continue; // exited since readdir, or not ours to read
    }
    const cmdline = raw.replace(/\0+$/, "").replaceAll("\0", " ");
    let cwd: string | undefined;
    try {
      cwd = readlinkSync(join(procRoot, entry, "cwd"));
    } catch {
      // kernel threads, other users' processes
    }
    if (mentionsPath(cmdline, path) || (cwd !== undefined && isInside(cwd, path))) out.push({ pid: Number(entry), cmdline });
  }
  return out;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signal(pid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false; // gone, or not ours (EPERM)
  }
}

async function killAll(procs: Proc[]): Promise<Proc[]> {
  const signalled = procs.filter((p) => signal(p.pid, "SIGTERM"));
  for (let i = 0; i < 50 && signalled.some((p) => alive(p.pid)); i++) await sleep(100);
  for (const p of signalled) if (alive(p.pid)) signal(p.pid, "SIGKILL");
  return signalled;
}

export async function remove(name: string, opts: { repo: string; worktreesDir: string }) {
  validateName(name);
  const dest = join(opts.worktreesDir, name);
  if (!existsSync(dest)) throw new Error(`${dest} does not exist`);
  const killed = await killAll(processesUnder(realpathSync(dest)));
  // --force: the objdir and mozconfig are untracked, git refuses without it. An objdir outside the tree
  // may be shared, so only the in-tree one goes, with the tree.
  await execOk(["git", "worktree", "remove", "--force", dest], { cwd: opts.repo });
  return { name, path: dest, killed, removed: true };
}

async function main() {
  await runCli(
    {
      create: async (args, values) => {
        const build = values.build as BuildKind;
        if (args.length !== 1 || !["artifact", "debug", "full"].includes(build)) {
          throw new UsageError("usage: create <name> [--base <ref>] --build artifact|debug|full");
        }
        const config = loadConfig();
        return create(args[0], { base: values.base as string | undefined, build, repo: config.firefoxRepo, worktreesDir: config.worktreesDir });
      },
      remove: async (args) => {
        if (args.length !== 1) throw new UsageError("usage: remove <name>");
        const config = loadConfig();
        return remove(args[0], { repo: config.firefoxRepo, worktreesDir: config.worktreesDir });
      },
    },
    { base: { type: "string" }, build: { type: "string" } },
  );
}

if (import.meta.main) {
  await main();
}
