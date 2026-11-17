// The worktree pool (config.worktreePool): how many item worktrees can be made this planning pass, and which idle ones
// to remove for the items that couldn't get one. main.ts gives next() the places; next() removes the picked ones.
import type { ItemWorktree, WorktreeBuild } from "./next.ts";

// Trees with a build compiled locally are big and slow to make: at most this many of each, within the pool.
export const COMPILED_SLOTS: Partial<Record<WorktreeBuild, number>> = { opt: 5, full: 5 };

// Whether one more worktree of that build fits, those there and those claimed this pass counted.
export function compiledRoom(build: WorktreeBuild, present: ItemWorktree[], claimed: WorktreeBuild[]): boolean {
  const cap = COMPILED_SLOTS[build];
  return cap === undefined || present.filter((w) => w.build === build).length + claimed.filter((b) => b === build).length < cap;
}

// Places left: the pool's size minus the worktrees there or being made, within what the disk has room for.
export function poolRoom(size: number, present: number, diskRoom: number): number {
  return Math.min(size - present, diskRoom);
}

// For each item still waiting (demand: the build it waits for), one idle worktree, those unused the longest first:
// of its build when that build's trees are all taken, else any. Those picked earlier and still there count.
export function pickEvictions(present: ItemWorktree[], evicting: Set<string>, demand: WorktreeBuild[]): string[] {
  const picked: string[] = [];
  const pending = present.filter((w) => evicting.has(w.name));
  const idle = present.filter((w) => w.idle && !evicting.has(w.name)).sort((a, b) => a.lastUsed - b.lastUsed);
  for (const build of demand) {
    const full = !compiledRoom(build, present, []);
    const covered = pending.findIndex((w) => !full || w.build === build);
    if (covered >= 0) {
      pending.splice(covered, 1);
      continue;
    }
    const i = idle.findIndex((w) => !full || w.build === build);
    if (i >= 0) picked.push(idle.splice(i, 1)[0].name);
  }
  return picked;
}
