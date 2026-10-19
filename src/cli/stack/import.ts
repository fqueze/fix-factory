import { git, readCommit, revList, title } from "./git.ts";
import { isTestOnly, parseBug, parseReviewers, parseRevision } from "./message.ts";

export interface ImportedCommit {
  sha: string;
  title: string;
  bug: number | null; // null for "Bug XXXXXXX" or no bug
  reviewers: string[];
  revision?: number;
  files: string[];
  insertions: number; // binary files count as 0
  deletions: number;
  testOnly: boolean;
  patchId?: string; // git patch-id --stable: the same for a reworded commit, "" when it changes nothing
}

export async function importStack(cwd: string, revset: string): Promise<ImportedCommit[]> {
  const out: ImportedCommit[] = [];
  for (const sha of await revList(cwd, [revset])) {
    const c = await readCommit(cwd, sha);
    const numstat = await git(cwd, ["diff", "--numstat", "--no-renames", "-z", `${sha}^`, sha]);
    const files: string[] = [];
    let insertions = 0;
    let deletions = 0;
    for (const entry of numstat.split("\0").filter(Boolean)) {
      const [ins, del, ...path] = entry.split("\t");
      files.push(path.join("\t"));
      insertions += Number(ins) || 0;
      deletions += Number(del) || 0;
    }
    const diff = await git(cwd, ["diff-tree", "-p", "--no-renames", sha]);
    const patchId = diff.trim() ? (await git(cwd, ["patch-id", "--stable"], { input: diff })).split(" ")[0] : "";
    const t = title(c.message);
    out.push({
      sha,
      title: t,
      bug: parseBug(t),
      reviewers: parseReviewers(t),
      revision: parseRevision(c.message),
      files,
      insertions,
      deletions,
      testOnly: isTestOnly(files),
      patchId,
    });
  }
  return out;
}
