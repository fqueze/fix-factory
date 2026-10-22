// What stays of a removed worktree: its artifacts/ (agents' evidence, reproduction notes, widening patches,
// logs and profiles up to KEEP_MAX_BYTES each) under <stateDir>/kept/<name>/, and its own commits under
// refs/fix-factory/<name>/ in the main checkout, so a patch can be looked at again after a backout.
import { existsSync } from "node:fs";
import { join, relative } from "node:path";

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
