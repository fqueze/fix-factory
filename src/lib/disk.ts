import { existsSync, statfsSync } from "node:fs";
import { dirname } from "node:path";

// A worktree and its build take ~6 GB; none is created on a disk with less than MIN_FREE_GB free.
export const WORKTREE_GB = 6;
export const MIN_FREE_GB = 20;

// Free space where the worktrees go (its parent until it exists).
export function freeDiskGB(dir: string): number {
  const fs = statfsSync(existsSync(dir) ? dir : dirname(dir));
  return (fs.bavail * fs.bsize) / 1e9;
}
