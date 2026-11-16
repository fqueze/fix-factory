import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitTry, mergeTree, readCommit } from "./git.ts";

export interface InterdiffResult {
  diff: string; // unified diff from the old version of the patch to the new one
  // "same-parent": both had the same parent; "old-rebased": old was rebased onto new's parent;
  // "new-rebased": the reverse; "conflicts-resolved": old rebased onto new's parent, its side winning each conflict.
  method: "same-parent" | "old-rebased" | "new-rebased" | "conflicts-resolved";
}

// Its commit message, when it changed, first, as a file COMMIT_MSG: resubmitting sends it too. Without the Differential
// Revision line, which only one of them may have.
async function messageDiff(cwd: string, oldMessage: string, newMessage: string): Promise<string> {
  const bare = (m: string) => m.replace(/^Differential Revision: \S+\n?/m, "").trimEnd() + "\n";
  if (bare(oldMessage) === bare(newMessage)) return "";
  const dir = mkdtempSync(join(tmpdir(), "interdiff-msg-"));
  try {
    writeFileSync(join(dir, "a"), bare(oldMessage));
    writeFileSync(join(dir, "b"), bare(newMessage));
    const r = await gitTry(dir, ["diff", "--no-index", "--no-color", "--no-ext-diff", "a", "b"]);
    return r.stdout.replace(/^diff --git a\/a b\/b\n/, "diff --git a/COMMIT_MSG b/COMMIT_MSG\n").replace(/^--- a\/a$/m, "--- a/COMMIT_MSG").replace(/^\+\+\+ b\/b$/m, "+++ b/COMMIT_MSG").replace(/^index .*\n/m, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// What changed in a patch between two versions, ignoring what the base contributed.
export async function interdiff(cwd: string, oldRef: string, newRef: string): Promise<InterdiffResult> {
  const [oldC, newC] = [await readCommit(cwd, oldRef), await readCommit(cwd, newRef)];
  const r = await codeInterdiff(cwd, oldC, newC);
  return { ...r, diff: (await messageDiff(cwd, oldC.message, newC.message)) + r.diff };
}

async function codeInterdiff(cwd: string, oldC: Awaited<ReturnType<typeof readCommit>>, newC: Awaited<ReturnType<typeof readCommit>>): Promise<InterdiffResult> {
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
