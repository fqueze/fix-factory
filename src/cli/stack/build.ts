import {
  assertClean,
  checkoutBranch,
  currentBranch,
  git,
  gitTry,
  leaveCherryPickInProgress,
  normalizedDiff,
  pick,
  readCommit,
  revList,
  revParse,
  type CommitObject,
} from "./git.ts";
import { editMessage, parseRevision, type MessageEdit } from "./message.ts";

export interface Conflict {
  sha: string;
  files: string[];
}

interface ChainItem {
  commit: CommitObject;
  message?: string;
  diff?: string;
}

interface ChainResult {
  head: string;
  mapping: { sha: string; newSha: string }[];
  empty: string[]; // original shas whose change was already in the tree they were applied to
  conflict?: { index: number; files: string[] };
}

async function buildChain(cwd: string, start: string, items: ChainItem[]): Promise<ChainResult> {
  let head = start;
  const mapping: ChainResult["mapping"] = [];
  const empty: string[] = [];
  for (const [index, item] of items.entries()) {
    const r = await pick(cwd, head, item.commit, { message: item.message, diff: item.diff });
    if (!r.ok) {
      return { head, mapping, empty, conflict: { index, files: r.files } };
    }
    if (r.empty) empty.push(item.commit.sha);
    mapping.push({ sha: item.commit.sha, newSha: r.sha });
    head = r.sha;
  }
  return { head, mapping, empty };
}

async function branchExists(cwd: string, branch: string): Promise<boolean> {
  return (await gitTry(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
}

export interface AssembleResult {
  branch: string;
  head: string; // the branch tip after the operation
  commits: { sha: string; newSha: string }[]; // picked commits, in order
  skipped: string[]; // already in the branch
  empty: string[];
  conflict?: Conflict;
  conflictLeft?: boolean; // true: the cherry-pick is in progress in the worktree, HEAD on the branch
  remaining?: string[]; // commits after the conflicting one, not applied
}

// Creates `branch` at `base` (or extends it if it exists) by cherry-picking `shas` in order, and checks
// it out in `cwd`. On conflict, the branch is left untouched unless `leaveConflict`, in which case it
// gets the commits before the conflict and the conflicting cherry-pick is left in progress.
export async function assemble(cwd: string, opts: { branch: string; base?: string; shas: string[]; leaveConflict?: boolean }): Promise<AssembleResult> {
  await assertClean(cwd);
  const exists = await branchExists(cwd, opts.branch);
  if (!exists && !opts.base) {
    throw new Error(`branch ${opts.branch} doesn't exist; --base is needed to create it`);
  }
  const start = await revParse(cwd, exists ? opts.branch : opts.base!);
  const items: ChainItem[] = [];
  const skipped: string[] = [];
  for (const s of opts.shas) {
    const commit = await readCommit(cwd, s);
    if ((await gitTry(cwd, ["merge-base", "--is-ancestor", commit.sha, start])).code === 0) {
      skipped.push(commit.sha);
    } else {
      items.push({ commit });
    }
  }
  const chain = await buildChain(cwd, start, items);
  const result: AssembleResult = { branch: opts.branch, head: chain.head, commits: chain.mapping, skipped, empty: chain.empty };
  if (chain.conflict) {
    const sha = items[chain.conflict.index].commit.sha;
    result.remaining = items.slice(chain.conflict.index + 1).map((i) => i.commit.sha);
    if (opts.leaveConflict) {
      await checkoutBranch(cwd, opts.branch, chain.head);
      result.conflict = { sha, files: await leaveCherryPickInProgress(cwd, sha) };
      result.conflictLeft = true;
    } else {
      result.head = exists ? start : "";
      result.commits = [];
      result.conflict = { sha, files: chain.conflict.files };
      result.conflictLeft = false;
    }
    return result;
  }
  await checkoutBranch(cwd, opts.branch, chain.head);
  return result;
}

export interface RewriteResult {
  branch: string;
  head: string;
  backup?: string; // ref pointing at the branch as it was before; absent when the branch wasn't touched
  shas: string[]; // new shas, in order (up to the conflict, if any)
  mapping: Record<string, string>; // old sha → new sha
  dropped: string[]; // commits of base..branch that weren't in the order
  empty: string[];
  diffChanged: string[]; // old shas whose diff (context included) changed
  changedRevisions: number[]; // D-numbers of those
  messageChangedRevisions: number[]; // D-numbers whose commit message changed
  conflict?: Conflict;
  conflictLeft?: boolean;
  remaining?: string[];
}

// Rebuilds the branch checked out in `cwd` (or `branch`) on `base`, in `order`, applying `edits`
// (keyed by sha). Commits whose parent and message don't change keep their sha. A conflict is
// handled like assemble's; after resolving a left conflict and running `git cherry-pick --continue`,
// run rewrite again with the branch's commits plus `remaining`: the unchanged prefix is reused.
export async function rewrite(
  cwd: string,
  opts: { base: string; order: string[]; edits?: Record<string, MessageEdit>; branch?: string; leaveConflict?: boolean },
): Promise<RewriteResult> {
  await assertClean(cwd);
  const branch = opts.branch ?? (await currentBranch(cwd));
  if (!branch) {
    throw new Error(`HEAD is detached in ${cwd}; pass --branch`);
  }
  const oldHead = await revParse(cwd, branch);
  const base = await revParse(cwd, opts.base);
  const before = await revList(cwd, [`${base}..${oldHead}`]);
  const edits = new Map<string, MessageEdit>();
  for (const [ref, edit] of Object.entries(opts.edits ?? {})) {
    edits.set(await revParse(cwd, ref), edit);
  }
  const items: ChainItem[] = [];
  for (const ref of opts.order) {
    const commit = await readCommit(cwd, ref);
    const edit = edits.get(commit.sha);
    items.push({ commit, message: edit ? editMessage(commit.message, edit) : undefined, diff: edit?.diff });
  }
  for (const sha of edits.keys()) {
    if (!items.some((i) => i.commit.sha === sha)) throw new Error(`edit for ${sha}, which isn't in the order`);
  }
  const chain = await buildChain(cwd, base, items);
  const dropped = before.filter((sha) => !items.some((i) => i.commit.sha === sha));
  if (chain.conflict && !opts.leaveConflict) {
    return {
      branch,
      head: oldHead,
      shas: [],
      mapping: {},
      dropped,
      empty: [],
      diffChanged: [],
      changedRevisions: [],
      messageChangedRevisions: [],
      conflict: { sha: items[chain.conflict.index].commit.sha, files: chain.conflict.files },
      conflictLeft: false,
      remaining: items.slice(chain.conflict.index + 1).map((i) => i.commit.sha),
    };
  }

  const backup = `refs/fix-factory/backup/${branch}/${Date.now()}`;
  await git(cwd, ["update-ref", backup, oldHead]);
  const result: RewriteResult = {
    branch,
    head: chain.head,
    backup,
    shas: chain.mapping.map((m) => m.newSha),
    mapping: Object.fromEntries(chain.mapping.map((m) => [m.sha, m.newSha])),
    dropped,
    empty: chain.empty,
    diffChanged: [],
    changedRevisions: [],
    messageChangedRevisions: [],
  };
  for (const [i, m] of chain.mapping.entries()) {
    if (m.sha === m.newSha) continue;
    const revision = parseRevision(items[i].commit.message);
    if ((await normalizedDiff(cwd, m.sha)) !== (await normalizedDiff(cwd, m.newSha))) {
      result.diffChanged.push(m.sha);
      if (revision !== undefined) result.changedRevisions.push(revision);
    }
    if (items[i].message !== undefined && items[i].message !== items[i].commit.message && revision !== undefined) {
      result.messageChangedRevisions.push(revision);
    }
  }

  if (chain.conflict) {
    const item = items[chain.conflict.index];
    result.remaining = items.slice(chain.conflict.index + 1).map((i) => i.commit.sha);
    await checkoutBranch(cwd, branch, chain.head);
    result.conflict = { sha: item.commit.sha, files: await leaveCherryPickInProgress(cwd, item.commit.sha, item.message) };
    result.conflictLeft = true;
    return result;
  }
  await checkoutBranch(cwd, branch, chain.head);
  return result;
}
