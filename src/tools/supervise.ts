// node src/tools/supervise.ts [--check] <script> [args…]
//
// Runs a factory process and restarts it when anything under src/ changes (prompts and schemas are read
// fresh by every job already). With --check, it restarts only once the typecheck and the tests pass, so a
// half-done edit never runs: the orchestrator uses it, the stateless web server doesn't need it.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { join, sep } from "node:path";

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
      if (check && !(passes(["npx", "tsc", "--noEmit"]) && passes(["npm", "test", "--silent"]))) {
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
