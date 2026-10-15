import { rmSync, writeFileSync } from "node:fs";
import { exec, execOk, type ExecResult } from "../../lib/exec.ts";

// Git plumbing shared by the stack subcommands. Everything goes through `git -C <cwd>`.
//
// Cherry-picks are computed in memory with `git merge-tree --write-tree --merge-base` (the same ort
// merge `git cherry-pick` uses) plus `git commit-tree`, so trying an order or rebuilding a stack
// never touches a worktree. A worktree is only updated once the result is known, or when a
// conflict has to be left in progress for someone to resolve.

export function git(cwd: string, args: string[], opts: { input?: string; env?: Record<string, string> } = {}): Promise<string> {
  return execOk(["git", "-C", cwd, ...args], { input: opts.input, env: opts.env && { ...process.env, ...opts.env } });
}

export function gitTry(cwd: string, args: string[], opts: { input?: string; env?: Record<string, string> } = {}): Promise<ExecResult> {
  return exec(["git", "-C", cwd, ...args], { input: opts.input, env: opts.env && { ...process.env, ...opts.env } });
}

export async function revParse(cwd: string, ref: string): Promise<string> {
  const r = await gitTry(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (r.code !== 0) {
    throw new Error(`unknown commit ${ref} in ${cwd}`);
  }
  return r.stdout.trim();
}

export interface CommitObject {
  sha: string;
  tree: string;
  parents: string[];
  author: { name: string; email: string; date: string }; // date in git's raw "<epoch> <tz>" format
  message: string; // exact message, trailing newline included
}

export async function readCommit(cwd: string, ref: string): Promise<CommitObject> {
  const sha = await revParse(cwd, ref);
  const raw = await git(cwd, ["cat-file", "commit", sha]);
  const sep = raw.indexOf("\n\n");
  const headers = (sep < 0 ? raw : raw.slice(0, sep)).split("\n");
  const message = sep < 0 ? "" : raw.slice(sep + 2);
  let tree = "";
  const parents: string[] = [];
  let author = { name: "", email: "", date: "" };
  for (const h of headers) {
    if (h.startsWith("tree ")) tree = h.slice(5);
    else if (h.startsWith("parent ")) parents.push(h.slice(7));
    else if (h.startsWith("author ")) {
      const m = /^author (.*) <(.*)> (\d+ [+-]\d{4})$/.exec(h);
      if (m) author = { name: m[1], email: m[2], date: m[3] };
    }
  }
  return { sha, tree, parents, author, message };
}

export function title(message: string): string {
  return message.split("\n", 1)[0].trim();
}

// Commits of a revset, oldest first.
export async function revList(cwd: string, revset: string[]): Promise<string[]> {
  const out = await git(cwd, ["rev-list", "--reverse", ...revset, "--"]);
  return out.split("\n").filter(Boolean);
}

export async function changedFiles(cwd: string, sha: string): Promise<string[]> {
  const out = await git(cwd, ["diff-tree", "--no-commit-id", "--name-only", "-r", "--no-renames", "-z", `${sha}^`, sha]);
  return out.split("\0").filter(Boolean);
}

export type MergeResult = { ok: true; tree: string } | { ok: false; files: string[] };

// Applies the change base→theirs on top of `onto`, like a cherry-pick, without a worktree.
export async function mergeTree(cwd: string, base: string, onto: string, theirs: string): Promise<MergeResult> {
  const r = await gitTry(cwd, ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", `--merge-base=${base}`, onto, theirs]);
  if (r.code === 0) {
    return { ok: true, tree: r.stdout.split("\0")[0].trim() };
  }
  if (r.code === 1) {
    // -z output: "<tree>\0<file>\0<file>\0...\0\0<messages>" (no messages with --no-messages).
    const parts = r.stdout.split("\0");
    const files: string[] = [];
    for (const p of parts.slice(1)) {
      if (p === "") break;
      if (!files.includes(p)) files.push(p);
    }
    return { ok: false, files };
  }
  throw new Error(`git merge-tree exited with ${r.code}: ${r.stderr.trim()}`);
}

export async function commitTree(cwd: string, tree: string, parent: string, message: string, author: CommitObject["author"]): Promise<string> {
  const out = await git(cwd, ["commit-tree", tree, "-p", parent, "-F", "-"], {
    input: message,
    env: { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_AUTHOR_DATE: author.date },
  });
  return out.trim();
}

// Applies a unified diff (e.g. a reviewer's suggested edit) to a tree, through a temporary index.
export async function applyDiffToTree(cwd: string, tree: string, diff: string): Promise<string> {
  const env = { GIT_INDEX_FILE: await gitPath(cwd, `fix-factory-index-${process.pid}-${Date.now()}`) };
  try {
    await git(cwd, ["read-tree", tree], { env });
    await git(cwd, ["apply", "--cached", "--whitespace=nowarn", "-"], { env, input: diff });
    return (await git(cwd, ["write-tree"], { env })).trim();
  } finally {
    rmSync(env.GIT_INDEX_FILE, { force: true });
  }
}

export type PickResult = { ok: true; sha: string; empty: boolean } | { ok: false; files: string[] };

// Cherry-picks `commit` onto `onto` in memory. When nothing changes (same parent, same message, no
// diff to apply), the original commit is reused so its sha stays stable.
export async function pick(cwd: string, onto: string, commit: CommitObject, opts: { message?: string; diff?: string } = {}): Promise<PickResult> {
  if (commit.parents.length !== 1) {
    throw new Error(`${commit.sha} has ${commit.parents.length} parents; only linear stacks are supported`);
  }
  const message = opts.message ?? commit.message;
  if (commit.parents[0] === onto && message === commit.message && !opts.diff) {
    return { ok: true, sha: commit.sha, empty: false };
  }
  let tree: string;
  if (commit.parents[0] === onto) {
    tree = commit.tree;
  } else {
    const m = await mergeTree(cwd, commit.parents[0], onto, commit.sha);
    if (!m.ok) return m;
    tree = m.tree;
  }
  if (opts.diff) {
    tree = await applyDiffToTree(cwd, tree, opts.diff);
  }
  const ontoTree = (await git(cwd, ["rev-parse", `${onto}^{tree}`])).trim();
  const sha = await commitTree(cwd, tree, onto, message, commit.author);
  return { ok: true, sha, empty: tree === ontoTree };
}

export async function currentBranch(cwd: string): Promise<string | null> {
  const r = await gitTry(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function gitPath(cwd: string, name: string): Promise<string> {
  const p = (await git(cwd, ["rev-parse", "--git-path", name])).trim();
  return p.startsWith("/") ? p : `${cwd}/${p}`;
}

export async function assertClean(cwd: string): Promise<void> {
  const r = await gitTry(cwd, ["rev-parse", "--verify", "--quiet", "CHERRY_PICK_HEAD"]);
  if (r.code === 0) {
    throw new Error(`a cherry-pick is in progress in ${cwd}; resolve it (git cherry-pick --continue) or abort it first`);
  }
  const status = await git(cwd, ["status", "--porcelain", "--untracked-files=no"]);
  if (status.trim()) {
    throw new Error(`${cwd} has uncommitted changes:\n${status}`);
  }
}

// Points `branch` at `head` and checks it out in the worktree, so HEAD ends up attached.
export async function checkoutBranch(cwd: string, branch: string, head: string): Promise<void> {
  await assertClean(cwd);
  await git(cwd, ["checkout", "--quiet", "-B", branch, head]);
}

// Leaves a real cherry-pick of `commit` in progress on top of the current HEAD, for a conflict to be
// resolved in the worktree. `message` becomes the message `git cherry-pick --continue` will use.
export async function leaveCherryPickInProgress(cwd: string, sha: string, message?: string): Promise<string[]> {
  const r = await gitTry(cwd, ["cherry-pick", sha]);
  if (r.code === 0) {
    throw new Error(`git merge-tree reported a conflict for ${sha}, but git cherry-pick applied it`);
  }
  const files = (await git(cwd, ["diff", "--name-only", "--diff-filter=U", "-z"])).split("\0").filter(Boolean);
  if (message !== undefined) {
    writeFileSync(await gitPath(cwd, "MERGE_MSG"), message);
  }
  return files;
}

// A patch's diff with what a rebase changes for free stripped out: blob ids and hunk line numbers.
// Context lines are kept: Lando applies the diff stored on Phabricator, so a patch whose context
// changed has to be resubmitted even if its +/- lines are the same.
export async function normalizedDiff(cwd: string, sha: string): Promise<string> {
  const out = await git(cwd, ["diff", "--no-color", "--no-ext-diff", "--no-renames", `${sha}^`, sha]);
  return out
    .split("\n")
    .filter((l) => !l.startsWith("index "))
    .map((l) => (l.startsWith("@@") ? l.replace(/^@@ [^@]* @@/, "@@") : l))
    .join("\n");
}
