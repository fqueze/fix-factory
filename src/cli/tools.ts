// The tools agents rely on, kept by the factory and up to date before a request starts.
//
//   node src/cli/tools.ts update
//     → {profilerCli: {rev, built, path}}
//     profiler-cli built from the profiler repository's main: a clone under <stateDir>/tools/profiler is
//     fetched, and when main moved, rebuilt (yarn install, yarn build-cli). Each build goes to its own
//     directory, tools/profiler-cli/<rev>, and tools/bin/profiler-cli is switched to it at once, so a run
//     using the previous one isn't broken mid-build. Agents find tools/bin first on PATH (run.ts).
//     One update at a time: requests starting together wait for each other.

import { existsSync, mkdirSync, renameSync, rmSync, statSync, symlinkSync, cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { log, runCli } from "../lib/cli.ts";
import { execOk } from "../lib/exec.ts";
import { loadConfig } from "../config.ts";

const PROFILER_REPO = "https://github.com/firefox-devtools/profiler.git";
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

export async function update(stateDir: string) {
  const tools = join(stateDir, "tools");
  mkdirSync(join(tools, "bin"), { recursive: true });
  return locked(join(tools, "update.lock"), async () => {
    const repo = join(tools, "profiler");
    if (!existsSync(repo)) {
      log(`cloning ${PROFILER_REPO}`);
      await execOk(["git", "clone", "--quiet", PROFILER_REPO, repo]);
    } else {
      await execOk(["git", "fetch", "--quiet", "origin", "main"], { cwd: repo });
    }
    const rev = (await execOk(["git", "rev-parse", "origin/main"], { cwd: repo })).trim();
    const out = join(tools, "profiler-cli", rev);
    const bin = join(tools, "bin", "profiler-cli");
    let built = false;
    if (!existsSync(join(out, "profiler-cli.js"))) {
      log(`building profiler-cli at ${rev.slice(0, 12)}`);
      await execOk(["git", "checkout", "--quiet", "--detach", rev], { cwd: repo });
      await execOk(["yarn", "install", "--frozen-lockfile", "--silent"], { cwd: repo, env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" } });
      await execOk(["yarn", "build-cli"], { cwd: repo, env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" } });
      rmSync(`${out}.tmp`, { recursive: true, force: true });
      cpSync(join(repo, "profiler-cli", "dist"), `${out}.tmp`, { recursive: true });
      renameSync(`${out}.tmp`, out);
      built = true;
    }
    // Node resolves the link, so the build finds its mappings.wasm next to it.
    pointTo(bin, join(out, "profiler-cli.js"));
    pointTo(join(tools, "bin", "pq"), join(out, "profiler-cli.js"));
    writeFileSync(join(tools, "profiler-cli.json"), JSON.stringify({ rev, at: new Date().toISOString() }) + "\n");
    const version = (await execOk([bin, "--version"])).trim();
    return { profilerCli: { rev, version, built, path: bin } };
  });
}

if (import.meta.main) {
  await runCli({ update: async () => update(loadConfig().stateDir) });
}
