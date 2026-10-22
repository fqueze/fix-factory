import { git, readCommit } from "./git.ts";
import { interdiff, type InterdiffResult } from "./interdiff.ts";

export interface SinceInput {
  old: string[]; // the commits an earlier push carried
  patches: { id: string; title: string; shas: string[] }[]; // each patch's current sha first, then its earlier ones
}

export interface SinceResult {
  changes: { patch: string; status: "same" | "changed" | "new"; old?: string; new: string; interdiff?: InterdiffResult }[];
  removed: { sha: string; title: string }[]; // in the earlier push, no longer in the stack (DEBUG commits included)
}

async function patchId(cwd: string, sha: string): Promise<string> {
  const out = await git(cwd, ["patch-id", "--stable"], { input: await git(cwd, ["show", "--no-color", "--no-ext-diff", sha]) });
  return out.split(" ")[0] ?? "";
}

const titleOf = (message: string) => message.split("\n")[0].trim();

// What changed in a stack since an earlier push: each patch matched with the commit that push carried, by patch-id
// (the stack's commits are cherry-picks of the authors'), else by title; an interdiff for each one that changed.
export async function since(cwd: string, input: SinceInput): Promise<SinceResult> {
  const old = await Promise.all(input.old.map(async (sha) => ({ sha, id: await patchId(cwd, sha), title: titleOf((await readCommit(cwd, sha)).message) })));
  const used = new Set<string>();
  const changes: SinceResult["changes"] = [];
  for (const p of input.patches) {
    const ids = await Promise.all(p.shas.map((s) => patchId(cwd, s)));
    const byId = old.find((o) => !used.has(o.sha) && ids.includes(o.id));
    const match = byId ?? old.find((o) => !used.has(o.sha) && o.title === p.title);
    if (!match) {
      changes.push({ patch: p.id, status: "new", new: p.shas[0] });
      continue;
    }
    used.add(match.sha);
    if (match.id === ids[0]) changes.push({ patch: p.id, status: "same", old: match.sha, new: p.shas[0] });
    else changes.push({ patch: p.id, status: "changed", old: match.sha, new: p.shas[0], interdiff: await interdiff(cwd, match.sha, p.shas[0]) });
  }
  return { changes, removed: old.filter((o) => !used.has(o.sha)).map((o) => ({ sha: o.sha, title: o.title })) };
}
