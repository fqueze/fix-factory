// What stays of a removed worktree: its artifacts/ (agents' evidence, reproduction notes, widening patches,
// logs and profiles up to KEEP_MAX_BYTES each) under <stateDir>/kept/<name>/, and its own commits under
// refs/fix-factory/<name>/ in the main checkout, so a patch can be looked at again after a backout.
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export const KEEP_MAX_BYTES = 20 * 1024 * 1024;

export function keptDir(stateDir: string, name: string): string {
  return join(stateDir, "kept", name);
}

// Where to read a path of a worktree now: the worktree while it exists, else its kept copy.
export function keptPath(dirs: { stateDir: string; worktreesDir: string }, path: string): string {
  if (existsSync(path)) return path;
  const rel = relative(dirs.worktreesDir, path);
  if (rel.startsWith("..")) return path;
  const [name, ...rest] = rel.split("/");
  return join(keptDir(dirs.stateDir, name), ...rest);
}

// The git directory to read a worktree's commits from: the worktree, else the main checkout (same objects).
export function gitDirFor(dirs: { firefoxRepo: string }, path: string): string {
  return existsSync(path) ? path : dirs.firefoxRepo;
}

// An item's own folder: its agents' notes (artifacts/evidence.md, reproduction.md, reproduction.diff…), copied from
// its worktree each time one of them ends, so they outlive the worktree and come back with the next one.
export const ITEM_NOTES_MAX_BYTES = 2 * 1024 * 1024;

export function itemDir(stateDir: string, request: string, item: string): string {
  return join(stateDir, "requests", request, "items", item);
}

// root's artifacts/ into to/artifacts/, without files over maxBytes (listed in skipped.txt) or symlinks.
export function copyArtifacts(root: string, to: string, maxBytes: number): { files: number; skipped: string[] } {
  const from = join(root, "artifacts");
  const out = { files: 0, skipped: [] as string[] };
  if (!existsSync(from)) return out;
  const walk = (rel: string) => {
    for (const e of readdirSync(join(from, rel), { withFileTypes: true })) {
      const r = join(rel, e.name);
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) {
        if (statSync(join(from, r)).size > maxBytes) out.skipped.push(r);
        else {
          mkdirSync(dirname(join(to, "artifacts", r)), { recursive: true });
          copyFileSync(join(from, r), join(to, "artifacts", r));
          out.files++;
        }
      }
    }
  };
  walk("");
  if (out.skipped.length) {
    mkdirSync(to, { recursive: true });
    writeFileSync(join(to, "skipped.txt"), out.skipped.join("\n") + "\n");
  }
  return out;
}
