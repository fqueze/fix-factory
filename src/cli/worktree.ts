// Firefox worktrees for agents: create (with a build) and remove. Port of the orchestrate-parallel-fixes
// skill's new-worktree.sh.
//
//   node src/cli/worktree.ts create <name> [--base <ref>] --build artifact|debug|opt|full|none [--notes <item folder>]
//     → {name, path, branch, base, build, mozconfig, objdir, smokeLog}
//     Creates <config.worktreesDir>/<name> on branch <name> (off --base, default: the checkout's current
//     branch; an existing branch is checked out as is), writes its mozconfig, runs ./mach build and a sanity
//     mochitest. Long-running: meant to run as a job. Build output goes to stderr.
//     artifact: opt artifact build. debug: debug artifact build (still about a minute). opt, full: opt and debug
//     builds compiled locally, for native code changes. none: no build, a plain worktree (a stack's).
//     With a build, <name> is a symlink to a slot (see slotsDir): a free one of that build, reset to the branch, or
//     a new one; its objdir is <objdirsDir>/<slot>.
//     --notes: the artifacts/ of an item's folder (its agents' notes) are copied into the tree's, for an item
//     whose worktree comes back.
//     A failed build leaves the worktree in place. Running create again with the same name reuses it (the
//     worktree at that path on branch <name>) and runs the build again, so a failed create can be retried.
//
//   node src/cli/worktree.ts remove <name>
//     → {name, path, killed: [{pid, cmdline}], removed: true, kept: {files, skipped}, refs}
//     Kills the processes whose command line names the worktree or whose working directory is in it (and
//     only those), then frees its slot (its build kept for the next item), or, for a worktree made before slots,
//     `git worktree remove --force`, which also deletes the in-tree objdir. The branch is
//     kept, and so are artifacts/ and the worktree's own commits (see src/lib/kept.ts). killed lists the
//     processes actually signalled.
//
// Worktrees live outside the checkout: worktrees inside it break `mach try`.

import { freeDiskGB, MIN_FREE_GB, WORKTREE_GB } from "../lib/disk.ts";
import { spawn } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statfsSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { copyArtifacts, ITEM_NOTES_MAX_BYTES, KEEP_MAX_BYTES, keptDir } from "../lib/kept.ts";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { log, runCli, UsageError } from "../lib/cli.ts";
import { netLog } from "../lib/netlog.ts";
import { exec, execOk } from "../lib/exec.ts";
import { loadConfig } from "../config.ts";

// artifact: opt artifact build; debug: debug artifact build; opt, full: opt and debug builds compiled locally (native
// code changes); none: no build (a stack's worktree: git only).
export type BuildKind = "artifact" | "debug" | "opt" | "full" | "none";
export const BUILD_KINDS: BuildKind[] = ["artifact", "debug", "opt", "full", "none"];

export function flavor(build: BuildKind): string {
  return { artifact: "opt-artifact", debug: "dbg-artifact", opt: "opt", full: "dbg", none: "none" }[build];
}

// objdir: where the build goes; in the tree (@TOPSRCDIR@/obj-<flavor>) for the worktrees made before slots.
export function mozconfig(build: BuildKind, objdir = `@TOPSRCDIR@/obj-${flavor(build)}`): string {
  const lines = ["mk_add_options AUTOCLOBBER=1", `mk_add_options MOZ_OBJDIR=${objdir}`];
  if (build === "debug" || build === "full") lines.push("ac_add_options --enable-debug");
  if (build === "artifact" || build === "debug") lines.push("ac_add_options --enable-artifact-builds");
  return lines.join("\n") + "\n";
}

// Worktrees with a build are slots, reused from item to item: <worktreesDir>/slots/<flavor>-<n>, their build in
// <objdirsDir>/<slot> (outside the tree, so resetting it for the next item keeps the build). An item's worktree is
// <worktreesDir>/<name>, a symlink to the slot it has now: its path, which its agents remember, never changes.
export function slotsDir(worktreesDir: string): string {
  return join(worktreesDir, "slots");
}

// The slots' builds by default: beside them (/build itself isn't writable).
export function objdirsDir(worktreesDir: string): string {
  return join(worktreesDir, "objdirs");
}

// The slots in use: those a worktree's symlink points to.
function slotsInUse(worktreesDir: string): Set<string> {
  const used = new Set<string>();
  for (const e of readdirSync(worktreesDir, { withFileTypes: true })) {
    if (e.isSymbolicLink()) used.add(basename(readlinkSync(join(worktreesDir, e.name))));
  }
  return used;
}

// A free slot of that flavor, locked for this process (a create running beside it picks another), or undefined.
function takeFreeSlot(worktreesDir: string, build: BuildKind): string | undefined {
  const dir = slotsDir(worktreesDir);
  if (!existsSync(dir)) return undefined;
  const used = slotsInUse(worktreesDir);
  for (const slot of readdirSync(dir).filter((n) => n.startsWith(`${flavor(build)}-`) && !n.endsWith(".lock") && !used.has(n)).sort()) {
    if (lockSlot(dir, slot)) return slot;
  }
  return undefined;
}

// A lock file naming its process; one whose process is gone is taken over.
function lockSlot(dir: string, slot: string): boolean {
  const lock = join(dir, `${slot}.lock`);
  try {
    writeFileSync(lock, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    const pid = Number(readFileSync(lock, "utf8"));
    if (pid && alive(pid)) return false;
    writeFileSync(lock, String(process.pid));
    return true;
  }
}

function newSlot(worktreesDir: string, build: BuildKind): string {
  const dir = slotsDir(worktreesDir);
  mkdirSync(dir, { recursive: true });
  for (let n = 1; ; n++) {
    const slot = `${flavor(build)}-${n}`;
    if (!existsSync(join(dir, slot)) && lockSlot(dir, slot)) return slot;
  }
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
export async function fetchRemoteBase(repo: string, base: string): Promise<void> {
  const ref = (await exec(["git", "rev-parse", "--symbolic-full-name", base], { cwd: repo })).stdout.trim();
  const m = /^refs\/remotes\/([^/]+)\/(.+)$/.exec(ref);
  if (!m) return;
  for (let attempt = 1; ; attempt++) {
    log(`git fetch ${m[1]} ${m[2]}`);
    const start = Date.now();
    const r = await exec(["git", "fetch", m[1], m[2]], { cwd: repo });
    const url = (await exec(["git", "remote", "get-url", m[1]], { cwd: repo })).stdout.trim();
    netLog({ start, end: Date.now(), method: "git fetch", url: `${url} ${m[2]}`, ...(r.code === 0 ? {} : { error: r.stderr.trim().slice(0, 300) }) });
    if (r.code === 0) return;
    if (attempt === 3) throw new Error(`git fetch ${m[1]} ${m[2]}: ${r.stderr.trim()}`);
    await sleep(5000 * attempt);
  }
}


export async function create(name: string, opts: { base?: string; build: BuildKind; repo: string; worktreesDir: string; objdirsDir?: string; notes?: string }) {
  validateName(name);
  const { repo } = opts;
  if (!existsSync(join(repo, "mach"))) throw new Error(`${repo} is not a Firefox checkout`);
  if (isInside(opts.worktreesDir, repo)) throw new Error(`worktreesDir ${opts.worktreesDir} is inside ${repo}`);
  const dest = join(opts.worktreesDir, name);
  const git = (args: string[]) => execOk(["git", ...args], { cwd: repo });

  let base: string;
  let slot: string | undefined;
  if (existsSync(dest)) {
    // A retry after a failed build: reuse the tree if it's ours, on our branch.
    if (!isWorktreeOn(await git(["worktree", "list", "--porcelain"]), realpathSync(dest), name)) throw new Error(`${dest} already exists and isn't the worktree of branch ${name}`);
    base = opts.base ?? name;
    if (lstatSync(dest).isSymbolicLink()) slot = basename(readlinkSync(dest));
    log(`reusing worktree ${dest}`);
  } else {
    let branchExists = (await exec(["git", "show-ref", "--verify", "--quiet", `refs/heads/${name}`], { cwd: repo })).code === 0;
    if (branchExists && opts.base) {
      // What a worktree add that failed (a full disk…) leaves: the branch, in no worktree, with nothing of its own.
      await git(["worktree", "prune"]);
      const used = (await git(["worktree", "list", "--porcelain"])).includes(`branch refs/heads/${name}\n`);
      const own = Number((await git(["rev-list", "--count", `${opts.base}..${name}`])).trim());
      if (used || own > 0) throw new Error(`branch ${name} already exists; --base would be ignored`);
      log(`deleting branch ${name}, left by a worktree add that failed`);
      await git(["branch", "-D", name]);
      branchExists = false;
    }
    base = branchExists ? name : (opts.base ?? (await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim());
    if (!branchExists) await fetchRemoteBase(repo, base);
    mkdirSync(opts.worktreesDir, { recursive: true });
    if (opts.build === "none") {
      log(`creating worktree ${dest} off ${base}`);
      await git(worktreeAddArgs(dest, name, base, branchExists));
    } else {
      // A free slot of its build, reset to the item's branch: its build is kept, and only what changed rebuilds.
      slot = takeFreeSlot(opts.worktreesDir, opts.build);
      const at = join(slotsDir(opts.worktreesDir), slot ?? "");
      try {
        if (slot) {
          log(`reusing slot ${slot} for ${name} off ${base}`);
          const g = (args: string[]) => execOk(["git", ...args], { cwd: at });
          await g(["checkout", "-q", "-f", ...(branchExists ? [name] : ["-b", name, base])]);
          // Everything untracked goes but the mozconfig, rewritten below: the build is outside the tree.
          await g(["clean", "-q", "-fdx", "-e", "/mozconfig"]);
        } else {
          const gb = freeDiskGB(opts.worktreesDir);
          if (gb < MIN_FREE_GB) throw new Error(`only ${gb.toFixed(1)} GB free on the disk of ${opts.worktreesDir}: a worktree needs ~${WORKTREE_GB} GB, and none is created under ${MIN_FREE_GB} GB`);
          slot = newSlot(opts.worktreesDir, opts.build);
          log(`creating slot ${slot} for ${name} off ${base}`);
          await git(worktreeAddArgs(join(slotsDir(opts.worktreesDir), slot), name, base, branchExists));
        }
        symlinkSync(join(slotsDir(opts.worktreesDir), slot), dest);
      } finally {
        if (slot) rmSync(join(slotsDir(opts.worktreesDir), `${slot}.lock`), { force: true });
      }
    }
  }

  const objdir = slot ? join(opts.objdirsDir ?? objdirsDir(opts.worktreesDir), slot) : join(dest, `obj-${flavor(opts.build)}`);
  const mozconfigPath = join(dest, "mozconfig");
  try {
    // mozconfig is untracked, so worktree add doesn't bring one across.
    writeFileSync(mozconfigPath, mozconfig(opts.build, slot ? objdir : undefined));
    mkdirSync(join(dest, "artifacts"), { recursive: true });
    // A stub, so a tree whose agent dies early still names itself.
    writeFileSync(join(dest, "artifacts/sessionlog.md"), `# ${name}\n\nWorktree \`${name}\`, branch \`${name}\`, off \`${base}\`.\n`);
    // Its agents' notes, sessionlog.md included, over the stub.
    if (opts.notes) copyArtifacts(opts.notes, dest, ITEM_NOTES_MAX_BYTES);
  } catch (e) {
    if (slot) unlinkSync(dest);
    else await exec(["git", "worktree", "remove", "--force", dest], { cwd: repo });
    throw e;
  }
  if (opts.build === "none") return { name, path: dest, branch: name, base, build: opts.build };

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

  return { name, path: dest, branch: name, base, build: opts.build, mozconfig: mozconfigPath, objdir, smokeLog, ...(slot ? { slot } : {}) };
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

export async function remove(name: string, opts: { repo: string; worktreesDir: string; stateDir: string }) {
  validateName(name);
  const dest = join(opts.worktreesDir, name);
  if (!existsSync(dest)) throw new Error(`${dest} does not exist`);
  // Processes may name the item's path (the symlink) or the slot's.
  const procs = [...processesUnder(realpathSync(dest)), ...(realpathSync(dest) === dest ? [] : processesUnder(dest))];
  const killed = await killAll(procs.filter((p, i) => procs.findIndex((q) => q.pid === p.pid) === i));
  const kept = copyArtifacts(dest, keptDir(opts.stateDir, name), KEEP_MAX_BYTES);
  const refs = await keepCommits(dest, name, opts.repo);
  // On a slot: the slot is freed for the next item, its build kept; the item's branch, no longer checked out, comes
  // back in whichever slot is free when it's needed again.
  if (lstatSync(dest).isSymbolicLink()) {
    const slot = basename(readlinkSync(dest));
    await execOk(["git", "checkout", "-q", "-f", "--detach"], { cwd: dest });
    unlinkSync(dest);
    return { name, path: dest, killed, removed: true, kept, refs, freed: slot };
  }
  // --force: the objdir and mozconfig are untracked, git refuses without it. An objdir outside the tree
  // may be shared, so only the in-tree one goes, with the tree.
  await execOk(["git", "worktree", "remove", "--force", dest], { cwd: opts.repo });
  return { name, path: dest, killed, removed: true, kept, refs };
}

// Every commit the worktree's HEAD pointed to that isn't upstream (earlier versions of its patches included)
// gets a ref, so git gc keeps it once the worktree's reflog is gone.
async function keepCommits(dest: string, name: string, repo: string): Promise<number> {
  const reflog = await exec(["git", "reflog", "--format=%H", "HEAD"], { cwd: dest });
  const tips = [...new Set(reflog.stdout.split("\n").filter(Boolean))];
  if (reflog.code !== 0 || tips.length === 0) return 0;
  const own = new Set((await execOk(["git", "rev-list", ...tips, "--not", "--remotes"], { cwd: repo })).split("\n"));
  const keep = tips.filter((sha) => own.has(sha));
  if (keep.length) await execOk(["git", "update-ref", "--stdin"], { cwd: repo, input: keep.map((sha) => `update refs/fix-factory/${name}/${sha} ${sha}\n`).join("") });
  return keep.length;
}

async function main() {
  await runCli(
    {
      create: async (args, values) => {
        const build = values.build as BuildKind;
        if (args.length !== 1 || !BUILD_KINDS.includes(build)) {
          throw new UsageError(`usage: create <name> [--base <ref>] --build ${BUILD_KINDS.join("|")} [--notes <dir>]`);
        }
        const config = loadConfig();
        return create(args[0], { base: values.base as string | undefined, build, repo: config.firefoxRepo, worktreesDir: config.worktreesDir, ...(config.objdirsDir ? { objdirsDir: config.objdirsDir } : {}), notes: values.notes as string | undefined });
      },
      remove: async (args) => {
        if (args.length !== 1) throw new UsageError("usage: remove <name>");
        const config = loadConfig();
        return remove(args[0], { repo: config.firefoxRepo, worktreesDir: config.worktreesDir, stateDir: config.stateDir });
      },
    },
    { base: { type: "string" }, build: { type: "string" }, notes: { type: "string" } },
  );
}

if (import.meta.main) {
  await main();
}
