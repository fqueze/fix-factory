import { git, mergeTree, readCommit } from "./git.ts";

export interface InterdiffResult {
  diff: string; // unified diff from the old version of the patch to the new one
  // "same-parent": both had the same parent; "old-rebased": old was rebased onto new's parent;
  // "new-rebased": the reverse; "diff-of-diffs": neither rebased cleanly, so this diffs the patches' text.
  method: "same-parent" | "old-rebased" | "new-rebased" | "diff-of-diffs";
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
  const blob = async (sha: string) => (await git(cwd, ["hash-object", "-w", "--stdin"], { input: await git(cwd, ["diff", "--no-color", `${sha}^`, sha]) })).trim();
  return { diff: await diff(await blob(oldC.sha), await blob(newC.sha)), method: "diff-of-diffs" };
}
