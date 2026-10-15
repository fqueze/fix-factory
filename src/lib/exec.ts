import { spawn } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Runs a command to completion. For short commands only; long-running work goes
// through the detached job runner (src/state/jobs.ts).
export function exec(cmd: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0], cmd.slice(1), { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(opts.input ?? "");
  });
}

export async function execOk(cmd: string[], opts: Parameters<typeof exec>[1] = {}): Promise<string> {
  const r = await exec(cmd, opts);
  if (r.code !== 0) {
    throw new Error(`${cmd.join(" ")} exited with ${r.code}: ${r.stderr.trim().slice(-2000)}`);
  }
  return r.stdout;
}

export async function execJson<T>(cmd: string[], opts: Parameters<typeof exec>[1] = {}): Promise<T> {
  return JSON.parse(await execOk(cmd, opts)) as T;
}
