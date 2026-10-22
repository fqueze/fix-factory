// The Markdown files and widening patch an author writes next to its fix (artifacts/evidence.md,
// artifacts/reproduction.md, artifacts/reproduction.diff), rendered by md-viewer and diff-viewer.
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "../lib/exec.ts";
import { keptPath } from "../lib/kept.ts";
import type { InvestigateReport, ItemView, RequestState } from "../types.ts";

export type AgentFile = keyof NonNullable<InvestigateReport["files"]>;
export const AGENT_FILES: AgentFile[] = ["evidence", "reproduction", "widening"];

// The file in the worktree of the group's latest investigation (or its kept copy, once the worktree is gone);
// never outside it, even through a symlink.
export function agentFilePath(r: RequestState, i: ItemView, which: AgentFile, dirs: { stateDir: string; worktreesDir: string }): string | undefined {
  const rel = i.investigation?.files?.[which];
  const author = i.jobs.map((j) => r.jobs[j]).findLast((j) => j.name === "investigate-and-fix");
  if (!rel || !author) {
    return undefined;
  }
  try {
    const root = realpathSync(keptPath(dirs, author.cwd));
    const path = realpathSync(resolve(root, rel));
    return path.startsWith(root + sep) ? path : undefined;
  } catch {
    return undefined; // missing
  }
}

// The rendered page can hold the agent's raw HTML: no script, no form posts, nothing loaded from elsewhere.
// diff-viewer's pages need their inline scripts. In a sandbox without allow-same-origin they run in an opaque origin:
// they can't read the factory's pages, and server.ts refuses commands posted from another origin.
export const AGENT_FILE_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:";

export async function renderAgentFile(opts: { mdViewer: string[]; diffViewer: string[]; path: string; title: string }): Promise<string> {
  if (opts.path.endsWith(".diff") || opts.path.endsWith(".patch")) {
    const dir = mkdtempSync(join(tmpdir(), "fix-factory-diff-viewer-"));
    try {
      const file = join(dir, "diff.html");
      const cmd = [...opts.diffViewer, "--no-open", "-t", opts.title, "-o", file, "--", opts.path];
      const r = await exec(cmd);
      if (r.code !== 0) {
        throw new Error(`${cmd.join(" ")} exited with ${r.code}: ${r.stderr.trim().slice(-2000)}`);
      }
      return readFileSync(file, "utf8");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // -n renders a standalone page into the temp directory and prints its file:// URL.
  const cmd = [...opts.mdViewer, "-n", "--no-open", "--", opts.path];
  const r = await exec(cmd);
  const url = /file:\/\/\S+/.exec(r.stdout)?.[0];
  if (r.code !== 0 || !url) {
    throw new Error(`${cmd.join(" ")} exited with ${r.code}: ${(r.stderr || r.stdout).trim().slice(-2000)}`);
  }
  return readFileSync(fileURLToPath(url), "utf8");
}
