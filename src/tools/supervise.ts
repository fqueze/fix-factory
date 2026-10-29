// node src/tools/supervise.ts [--check] <script> [args…]
//
// Runs a factory process and restarts it when anything under src/ changes (prompts and schemas are read
// fresh by every job already). With --check, it restarts only once the typecheck and the tests pass, so a
// half-done edit never runs: the orchestrator and the web server both use it (a page reloaded on a broken one is stuck).
// The supervisors share one check per version of the code: a second one waits for the first's result.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { join, sep } from "node:path";

// What the typecheck and the tests read: a version of the code.
export function codeFingerprint(root: string): string {
  const hash = createHash("sha1");
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(d, e.name);
      if (e.isDirectory()) walk(path);
      else if (e.isFile()) hash.update(path).update(readFileSync(path));
    }
  };
  for (const d of ["src", "test", "schemas", "prompts", "docs"]) if (statSync(join(root, d), { throwIfNoEntry: false })?.isDirectory()) walk(join(root, d));
  for (const f of ["package.json", "tsconfig.json"]) if (statSync(join(root, f), { throwIfNoEntry: false })) hash.update(f).update(readFileSync(join(root, f)));
  return hash.digest("hex");
}

const log = (text: string) => process.stderr.write(`supervise: ${text}\n`);

// Calls onChange for any change under dir. One plain watch per directory, not {recursive: true}: on Linux
// that one watches each file's inode, and misses later edits of a file replaced by a rename (editors, git).
export function watchTree(dir: string, onChange: () => void, onError: (e: Error) => void): () => void {
  const watchers = new Map<string, FSWatcher>();
  function drop(d: string): void {
    for (const [path, w] of watchers) {
      if (path === d || path.startsWith(d + sep)) {
        w.close();
        watchers.delete(path);
      }
    }
  }
  function add(d: string): void {
    if (watchers.has(d)) return;
    try {
      const w = watch(d, (_type, name) => {
        if (name) {
          const path = join(d, name);
          if (statSync(path, { throwIfNoEntry: false })?.isDirectory()) add(path);
          else drop(path);
        }
        onChange();
      });
      w.on("error", (e) => {
        onError(e);
        drop(d);
      });
      watchers.set(d, w);
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) add(join(d, e.name));
      }
    } catch (e) {
      // Removed as soon as created.
      onError(e as Error);
    }
  }
  add(dir);
  return () => drop(dir);
}

if (import.meta.main) main();

function main(): void {
  const root = join(import.meta.dirname, "../..");
  const args = process.argv.slice(2);
  const check = args[0] === "--check";
  if (check) args.shift();
  if (!args.length) {
    process.stderr.write("usage: node src/tools/supervise.ts [--check] <script> [args…]\n");
    process.exit(2);
  }

  let child: ChildProcess | undefined;
  // Children this stopped: their exit isn't news. The orchestrator exits with 0 on SIGTERM.
  const stopped = new WeakSet<ChildProcess>();
  let exiting = false;
  function start(): void {
    if (exiting) return;
    const c = spawn(process.execPath, args, { cwd: root, stdio: "inherit" });
    child = c;
    c.on("exit", (code, signal) => {
      if (!stopped.has(c)) log(`${args[0]} exited (${signal ?? code}); it starts again on the next change`);
    });
  }

  function stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
      const c = child;
      // One whose event loop is stuck never runs its SIGTERM handler.
      const kill = setTimeout(() => {
        log(`${args[0]} didn't exit 10 s after SIGTERM: killing it`);
        c.kill("SIGKILL");
      }, 10_000);
      c.once("exit", () => {
        clearTimeout(kill);
        resolve();
      });
      stopped.add(c);
      c.kill("SIGTERM");
    });
  }

  // Its output only when it fails: the last lines say why. A hanging test mustn't block restarts forever.
  function passes(command: string[]): boolean {
    const r = spawnSync(command[0], command.slice(1), { cwd: root, encoding: "utf8", timeout: 10 * 60 * 1000 });
    if (r.status === 0) return true;
    log(`${command.join(" ")} failed${r.error ? ` (${r.error.message})` : ""}:\n${`${r.stdout}${r.stderr}`.trim().split("\n").slice(-20).join("\n")}`);
    return false;
  }

  // One check per version of the code, whichever supervisor runs it.
  const cacheDir = join(root, "node_modules/.cache/fix-factory");
  const resultFile = join(cacheDir, "check.json");
  const lockFile = join(cacheDir, "check.lock");
  const readJson = (f: string): { fp: string; ok?: boolean; pid?: number } | undefined => {
    try {
      return JSON.parse(readFileSync(f, "utf8"));
    } catch {
      return undefined; // none yet
    }
  };
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  async function checked(): Promise<boolean> {
    mkdirSync(cacheDir, { recursive: true });
    const fp = codeFingerprint(root);
    for (;;) {
      const result = readJson(resultFile);
      if (result?.fp === fp) return result.ok === true;
      const lock = readJson(lockFile);
      if (!lock || lock.fp !== fp || !alive(lock.pid!)) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    writeFileSync(lockFile, JSON.stringify({ fp, pid: process.pid }));
    const ok = passes(["npx", "tsc", "--noEmit"]) && passes(["npm", "test", "--silent"]);
    writeFileSync(resultFile, JSON.stringify({ fp, ok }));
    rmSync(lockFile, { force: true });
    return ok;
  }

  let busy = false;
  let again = false;
  async function restart(): Promise<void> {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    do {
      again = false;
      if (check && !(await checked())) {
        log("keeping the running version");
        continue;
      }
      await stop();
      start();
      if (!exiting) log(`restarted ${args[0]}`);
    } while (again);
    busy = false;
  }

  // Editors write a file in several steps, and edits come in bursts.
  let timer: NodeJS.Timeout | undefined;
  watchTree(
    join(root, "src"),
    () => {
      clearTimeout(timer);
      timer = setTimeout(() => void restart(), 1000);
    },
    (e) => log(`watching: ${e.message}`),
  );
  // The child goes with supervise; start() won't start another during an in-flight restart.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      // A second Ctrl-C doesn't wait any more.
      if (exiting) {
        child?.kill("SIGKILL");
        process.exit(1);
      }
      exiting = true;
      void stop().then(() => process.exit(0));
    });
  }
  process.on("exit", () => child?.kill("SIGTERM"));
  start();
}
