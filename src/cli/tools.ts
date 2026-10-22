// The tools agents rely on, kept by the factory and up to date before a request starts.
//
//   node src/cli/tools.ts update
//     → {profilerCli: {rev, version, built, path, supported: {gecko, processed}, made: {gecko, processed}, ciProfilerRev},
//        fxTests: {rev, built}, mdViewer: {rev, built}}
//     profiler-cli built from the profiler repository's main: a clone under <stateDir>/tools/profiler is
//     fetched, and when main moved, rebuilt (yarn install, yarn build-cli). Each build goes to its own
//     directory, tools/profiler-cli/<rev>, and tools/bin/profiler-cli is switched to it at once, so a run
//     using the previous one isn't broken mid-build. Agents find tools/bin first on PATH (run.ts).
//     One update at a time: requests starting together wait for each other.
//     fx-tests from mozilla/aretestsfastyet's main, in tools/fx-tests/<rev>.
//     md-viewer (with diff-viewer and stack-viewer, which the page runs) the same way, from its repository's main,
//     in tools/md-viewer-at/<rev>.
//     Then the profile versions it supports are compared with those Firefox's CI makes (see profileVersions):
//     an older build fails the update.

import { cpSync, existsSync, mkdirSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { log, runCli } from "../lib/cli.ts";
import { exec, execOk } from "../lib/exec.ts";
import { loadConfig } from "../config.ts";

const PROFILER_REPO = "https://github.com/firefox-devtools/profiler.git";
const FX_TESTS_REPO = "https://github.com/mozilla/aretestsfastyet.git";
const MD_VIEWER_REPO = "https://github.com/fqueze/md-viewer.git";
export const VIEWERS = ["md-viewer", "diff-viewer", "stack-viewer"] as const;
const LOCK_STALE_MS = 30 * 60_000;

export function toolsBin(stateDir: string): string {
  return join(stateDir, "tools", "bin");
}

// A directory as a lock; one older than a build can take is left over from a killed update.
async function locked<T>(dir: string, f: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      mkdirSync(dir);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (Date.now() - statSync(dir).mtimeMs > LOCK_STALE_MS) rmSync(dir, { recursive: true, force: true });
      else await sleep(2000);
    }
  }
  try {
    return await f();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Replaces a symlink in one step.
function pointTo(link: string, target: string): void {
  const tmp = `${link}.new`;
  rmSync(tmp, { force: true });
  symlinkSync(target, tmp);
  renameSync(tmp, link);
}

// Profile format versions. Gecko writes its raw format (GECKO_PROFILER_FORMAT_VERSION in mozglue); CI turns it into
// the processed format with the profiler revision toolchains.yml pins, whose constants.ts gives that version.
export function parseConstants(ts: string): { gecko: number; processed: number } {
  const n = (name: string) => Number(ts.match(new RegExp(`export const ${name} = (\\d+);`))?.[1] ?? NaN);
  return { gecko: n("GECKO_PROFILE_VERSION"), processed: n("PROCESSED_PROFILE_VERSION") };
}

export function pinnedProfilerRev(toolchainsYml: string): string | undefined {
  return toolchainsYml.match(/repo: https:\/\/github\.com\/firefox-devtools\/profiler\s*\n\s*revision: ([0-9a-f]{40})/)?.[1];
}

export function parseGeckoFormat(header: string): number {
  return Number(header.match(/GECKO_PROFILER_FORMAT_VERSION = (\d+);/)?.[1] ?? NaN);
}

const gitShow = (cwd: string, rev: string, path: string) => execOk(["git", "show", `${rev}:${path}`], { cwd });

// What Firefox at ref makes, and what the profiler built at rev reads.
export async function profileVersions(repo: string, rev: string, firefox: string, ref: string) {
  const pinned = pinnedProfilerRev(await gitShow(firefox, ref, "taskcluster/kinds/fetch/toolchains.yml"));
  if (!pinned) throw new Error(`no firefox-devtools/profiler revision in ${ref}:taskcluster/kinds/fetch/toolchains.yml`);
  if ((await exec(["git", "cat-file", "-e", `${pinned}^{commit}`], { cwd: repo })).code !== 0) await execOk(["git", "fetch", "--quiet", "origin", pinned], { cwd: repo });
  const ci = parseConstants(await gitShow(repo, pinned, "src/app-logic/constants.ts"));
  const supported = parseConstants(await gitShow(repo, rev, "src/app-logic/constants.ts"));
  const gecko = parseGeckoFormat(await gitShow(firefox, ref, "mozglue/baseprofiler/public/BaseAndGeckoProfilerDetail.h"));
  return { supported, made: { gecko, processed: ci.processed }, ciProfilerRev: pinned };
}

// A clone under tools/, at its remote's main.
async function fetched(url: string, repo: string): Promise<string> {
  if (!existsSync(repo)) {
    log(`cloning ${url}`);
    await execOk(["git", "clone", "--quiet", url, repo]);
  } else {
    await execOk(["git", "fetch", "--quiet", "origin", "main"], { cwd: repo });
  }
  return (await execOk(["git", "rev-parse", "origin/main"], { cwd: repo })).trim();
}

const YARN_ENV = { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };

async function profilerCli(tools: string, firefox: { repo: string; ref: string }) {
  const repo = join(tools, "profiler");
  const rev = await fetched(PROFILER_REPO, repo);
  const out = join(tools, "profiler-cli", rev);
  const bin = join(tools, "bin", "profiler-cli");
  let built = false;
  if (!existsSync(join(out, "profiler-cli.js"))) {
    log(`building profiler-cli at ${rev.slice(0, 12)}`);
    await execOk(["git", "checkout", "--quiet", "--detach", rev], { cwd: repo });
    await execOk(["yarn", "install", "--frozen-lockfile", "--silent"], { cwd: repo, env: YARN_ENV });
    await execOk(["yarn", "build-cli"], { cwd: repo, env: YARN_ENV });
    rmSync(`${out}.tmp`, { recursive: true, force: true });
    cpSync(join(repo, "profiler-cli", "dist"), `${out}.tmp`, { recursive: true });
    renameSync(`${out}.tmp`, out);
    built = true;
  }
  // Node resolves the link, so the build finds its mappings.wasm next to it.
  pointTo(bin, join(out, "profiler-cli.js"));
  pointTo(join(tools, "bin", "pq"), join(out, "profiler-cli.js"));
  const version = (await execOk([bin, "--version"])).trim();
  const versions = await profileVersions(repo, rev, firefox.repo, firefox.ref);
  const { supported, made } = versions;
  if (!(supported.gecko >= made.gecko && supported.processed >= made.processed)) {
    throw new Error(`profiler-cli at ${rev.slice(0, 12)} reads profiles up to version ${supported.processed} (gecko format ${supported.gecko}), but Firefox's CI makes version ${made.processed} (gecko format ${made.gecko})`);
  }
  return { rev, version, built, path: bin, ...versions };
}

// fx-tests: its repository commits the bundle, which reads its docs.
async function fxTests(tools: string) {
  const repo = join(tools, "aretestsfastyet");
  const rev = await fetched(FX_TESTS_REPO, repo);
  const out = join(tools, "fx-tests", rev);
  let built = false;
  if (!existsSync(out)) {
    await execOk(["git", "checkout", "--quiet", "--detach", rev], { cwd: repo });
    rmSync(`${out}.tmp`, { recursive: true, force: true });
    for (const dir of ["dist", "docs"]) cpSync(join(repo, dir), join(`${out}.tmp`, dir), { recursive: true });
    renameSync(`${out}.tmp`, out);
    built = true;
  }
  pointTo(join(tools, "bin", "fx-tests"), join(out, "dist", "fx-tests.js"));
  return { rev, built };
}

// md-viewer, diff-viewer and stack-viewer, for the page: a checkout per revision with its node_modules.
async function mdViewer(tools: string) {
  const repo = join(tools, "md-viewer");
  const rev = await fetched(MD_VIEWER_REPO, repo);
  const out = join(tools, "md-viewer-at", rev);
  let built = false;
  if (!existsSync(join(out, "node_modules"))) {
    log(`installing md-viewer at ${rev.slice(0, 12)}`);
    rmSync(out, { recursive: true, force: true });
    await execOk(["git", "worktree", "prune"], { cwd: repo });
    await execOk(["git", "worktree", "add", "--quiet", "--detach", out, rev], { cwd: repo });
    await execOk(["npm", "ci", "--omit=dev", "--silent"], { cwd: out });
    built = true;
  }
  for (const name of VIEWERS) pointTo(join(tools, "bin", name), join(out, `${name}.js`));
  return { rev, built };
}

export async function update(stateDir: string, firefox: { repo: string; ref: string }) {
  const tools = join(stateDir, "tools");
  mkdirSync(join(tools, "bin"), { recursive: true });
  return locked(join(tools, "update.lock"), async () => ({ profilerCli: await profilerCli(tools, firefox), fxTests: await fxTests(tools), mdViewer: await mdViewer(tools) }));
}

// The viewers' commands the page runs, unless the config names others.
export function viewerCommand(stateDir: string, name: (typeof VIEWERS)[number]): string[] {
  return [join(toolsBin(stateDir), name)];
}

if (import.meta.main) {
  await runCli({
    update: async () => {
      const config = loadConfig();
      return update(config.stateDir, { repo: config.firefoxRepo, ref: config.baseRef });
    },
  });
}
