// node src/tools/supervise.ts [--check] <script> [args…]
//
// Runs a factory process and restarts it when anything under src/ changes (prompts and schemas are read
// fresh by every job already). With --check, it restarts only once the typecheck and the tests pass, so a
// half-done edit never runs: the orchestrator uses it, the stateless web server doesn't need it.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { watch } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const check = args[0] === "--check";
if (check) args.shift();
if (!args.length) {
  process.stderr.write("usage: node src/tools/supervise.ts [--check] <script> [args…]\n");
  process.exit(2);
}

const log = (text: string) => process.stderr.write(`supervise: ${text}\n`);

let child: ChildProcess | undefined;
function start(): void {
  child = spawn(process.execPath, args, { cwd: root, stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (signal !== "SIGTERM") log(`${args[0]} exited (${signal ?? code}); it starts again on the next change`);
  });
}

function stop(): Promise<void> {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

// Its output only when it fails: the last lines say why.
function passes(command: string[]): boolean {
  const r = spawnSync(command[0], command.slice(1), { cwd: root, encoding: "utf8" });
  if (r.status === 0) return true;
  log(`${command.join(" ")} failed:\n${`${r.stdout}${r.stderr}`.trim().split("\n").slice(-20).join("\n")}`);
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
    log(`restarted ${args[0]}`);
  } while (again);
  busy = false;
}

// Editors write a file in several steps, and edits come in bursts.
let timer: NodeJS.Timeout | undefined;
watch(join(root, "src"), { recursive: true }, () => {
  clearTimeout(timer);
  timer = setTimeout(() => void restart(), 1000);
});
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => void stop().then(() => process.exit(0)));
}
start();
