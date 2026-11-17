// The worktree pool (config.worktreePool): how many item worktrees can be made this planning pass, and which idle ones
// to remove for the items that couldn't get one. main.ts gives next() the places; next() removes the picked ones.
import type { ItemWorktree } from "./next.ts";

// Places left: the pool's size minus the worktrees there or being made, within what the disk has room for.
export function poolRoom(size: number, present: number, diskRoom: number): number {
  return Math.min(size - present, diskRoom);
}

// For each item still waiting (demand), one idle worktree, those unused the longest first; those picked earlier and
// still there count.
export function pickEvictions(present: ItemWorktree[], evicting: Set<string>, demand: number): string[] {
  const pending = present.filter((w) => evicting.has(w.name)).length;
  return present
    .filter((w) => w.idle && !evicting.has(w.name))
    .sort((a, b) => a.lastUsed - b.lastUsed)
    .slice(0, Math.max(0, demand - pending))
    .map((w) => w.name);
}
