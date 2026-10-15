import type { Dep } from "../../types.ts";
import { log } from "../../lib/cli.ts";
import { changedFiles, git, pick, readCommit, revList, revParse, title, type CommitObject } from "./git.ts";

// Textual dependencies of the commits in base..HEAD, found by cherry-picking in memory (git
// merge-tree), so no worktree is checked out. Patch ids in the output are the commit shas.
//
// Hard: a commit that doesn't apply alone on the base needs some earlier commits. We start from the
// earlier commits touching the same files (or all earlier commits if that isn't enough), then drop
// each one whose absence still lets it apply. What is left are the direct deps; deps of deps are
// always applied along (transitive closure), so they aren't repeated.
// Soft candidates: two commits touching the same files, neither depending on the other, that apply
// in one order but conflict in the other, or apply in both orders with different results.

export async function detectDeps(cwd: string, base: string): Promise<Dep[]> {
  const baseSha = await revParse(cwd, base);
  const shas = await revList(cwd, [`${baseSha}..HEAD`]);
  const commits: CommitObject[] = [];
  const files: Set<string>[] = [];
  for (const sha of shas) {
    commits.push(await readCommit(cwd, sha));
    files.push(new Set(await changedFiles(cwd, sha)));
  }
  const overlap = (a: number, b: number) => [...files[a]].some((f) => files[b].has(f));
  const label = (i: number) => `${shas[i].slice(0, 12)} "${title(commits[i].message)}"`;

  // Applying a sequence of commits on the base; prefixes are cached.
  type Applied = { ok: true; head: string } | { ok: false; at: number; files: string[] };
  const cache = new Map<string, Applied>();
  const apply = async (seq: number[]): Promise<Applied> => {
    let head = baseSha;
    let key = "";
    for (const idx of seq) {
      key += `,${idx}`;
      let r = cache.get(key);
      if (!r) {
        const p = await pick(cwd, head, commits[idx]);
        r = p.ok ? { ok: true, head: p.sha } : { ok: false, at: idx, files: p.files };
        cache.set(key, r);
      }
      if (!r.ok) return r;
      head = r.head;
    }
    return { ok: true, head };
  };

  const hard = new Map<number, number[]>();
  const closure = (set: Iterable<number>): number[] => {
    const out = new Set<number>();
    const visit = (i: number) => {
      if (out.has(i)) return;
      out.add(i);
      for (const d of hard.get(i) ?? []) visit(d);
    };
    for (const i of set) visit(i);
    return [...out].sort((a, b) => a - b);
  };
  const applyOnTop = (set: number[], i: number) => apply([...closure(set).filter((j) => j !== i), i]);

  const deps: Dep[] = [];
  for (let i = 0; i < commits.length; i++) {
    const alone = await applyOnTop([], i);
    if (alone.ok) continue;
    let needed = [...Array(i).keys()].filter((j) => overlap(i, j));
    if (!(await applyOnTop(needed, i)).ok) {
      needed = [...Array(i).keys()];
      if (!(await applyOnTop(needed, i)).ok) {
        log(`deps: ${label(i)} doesn't apply even on top of every earlier commit`);
        continue;
      }
    }
    for (const j of [...needed].reverse()) {
      const without = needed.filter((k) => k !== j);
      if ((await applyOnTop(without, i)).ok) needed = without;
    }
    hard.set(i, needed);
    const conflictFiles = alone.files.join(", ");
    for (const j of needed) {
      deps.push({ patch: shas[i], needs: shas[j], kind: "hard", reason: `doesn't apply without ${label(j)} (conflicts in ${conflictFiles})`, source: "textual" });
    }
  }

  for (let j = 0; j < commits.length; j++) {
    const jClosure = closure([j]);
    for (let i = 0; i < j; i++) {
      if (!overlap(i, j) || jClosure.includes(i)) continue;
      const context = closure([...(hard.get(i) ?? []), ...(hard.get(j) ?? [])]);
      const forward = await apply([...context, i, j]);
      const backward = await apply([...context, j, i]);
      if (forward.ok && backward.ok) {
        const tree = (sha: string) => git(cwd, ["rev-parse", `${sha}^{tree}`]);
        if ((await tree(forward.head)) !== (await tree(backward.head))) {
          deps.push({ patch: shas[j], needs: shas[i], kind: "soft", reason: `${label(i)} and ${label(j)} apply in both orders, with different results`, source: "textual" });
        }
        continue;
      }
      if (!forward.ok && !backward.ok) continue;
      const [first, second, failed] = forward.ok ? [i, j, backward] : [j, i, forward];
      const files = failed.ok ? "" : failed.files.join(", ");
      deps.push({
        patch: shas[second],
        needs: shas[first],
        kind: "soft",
        reason: `conflicts in ${files} when ${label(second)} is placed before ${label(first)}`,
        source: "textual",
      });
    }
  }
  return deps;
}
