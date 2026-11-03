import { git, mergeTree, readCommit } from "./git.ts";

export interface InterdiffResult {
  diff: string; // unified diff from the old version of the patch to the new one
  // "same-parent": both had the same parent; "old-rebased": old was rebased onto new's parent;
  // "new-rebased": the reverse; "conflicts-resolved": old rebased onto new's parent, its side winning each conflict.
  method: "same-parent" | "old-rebased" | "new-rebased" | "conflicts-resolved";
}

// What changed in a patch between two versions, ignoring what the base contributed.
export async function interdiff(cwd: string, oldRef: string, newRef: string): Promise<InterdiffResult> {
  const [oldC, newC] = [await readCommit(cwd, oldRef), await readCommit(cwd, newRef)];
  const diff = (a: string, b: string) => git(cwd, ["diff", "--no-color", "--no-ext-diff", a, b]);
  if (oldC.parents[0] === newC.parents[0]) {
    return { diff: await diff(oldC.sha, newC.sha), method: "same-parent" };
  }
  const oldOnNew = await mergeTree(cwd, oldC.parents[0], newC.parents[0], oldC.sha);
  if (oldOnNew.ok) {
    return { diff: await diff(oldOnNew.tree, newC.tree), method: "old-rebased" };
  }
  const newOnOld = await mergeTree(cwd, newC.parents[0], oldC.parents[0], newC.sha);
  if (newOnOld.ok) {
    return { diff: await diff(oldC.tree, newOnOld.tree), method: "new-rebased" };
  }
  // Today's base conflicting with the old version: the old version applied onto the new base, its own side winning
  // each conflict, against the new one, ignoring whitespace (a resolution often re-indents a block). What differs is
  // how the conflict was resolved and anything else changed.
  const forced = (await git(cwd, ["merge-tree", "--write-tree", "--no-messages", "-X", "theirs", `--merge-base=${oldC.parents[0]}`, newC.parents[0], oldC.sha])).split("\n")[0].trim();
  const resolved = await git(cwd, ["diff", "--no-color", "--no-ext-diff", "-w", forced, newC.tree]);
  return { diff: `# ${oldOnNew.files.join(", ")} conflicted with the new base: compared with the old version applied onto it (its side of each conflict), ignoring whitespace\n${resolved}`, method: "conflicts-resolved" };
}
