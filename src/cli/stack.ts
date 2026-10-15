// stack.ts: every git operation on a patch stack. Never interactive rebase, never `git push`, never
// a detached HEAD at the end; always `git -C <cwd>`. Cherry-picks are computed in memory (git
// merge-tree + commit-tree, see stack/git.ts); worktrees are only updated with the final result.
//
// node src/cli/stack.ts <subcommand> --cwd <stack worktree> ...  (--cwd is required by the git subcommands)
//
// import <revset>
//   → ImportedCommit[] (oldest first): {sha, title, bug: number | null, reviewers: string[],
//     revision?: number, files: string[], insertions, deletions, testOnly}. testOnly heuristic: see
//     isTestFile in stack/message.ts.
// assemble --branch <name> [--base <ref>] [--leave-conflict] <sha...>
//   Creates the branch at base (or extends it), cherry-picks the shas in order, checks it out.
//   → {branch, head, commits: [{sha, newSha}], skipped, empty, conflict?: {sha, files},
//      conflictLeft?, remaining?}. Without --leave-conflict a conflict leaves the branch untouched.
// deps --base <ref>
//   → Dep[] (source "textual") for base..HEAD; patch ids are the commit shas.
// order <input.json | -> [--landable]
//   input: {patches: [{id, effort?, value?, testOnly?, accepted?, commentsAddressed?, landed?}],
//           deps: Dep[], previous?: PatchId[]}
//   → {order: PatchId[], flippedSoftDeps: Dep[], landable?: PatchId[]}. Rules in stack/order.ts.
// rewrite --base <ref> --order <sha>[,<sha>...] [<sha>...] [--edits <edits.json>] [--branch <name>] [--leave-conflict]
//   edits: {"<sha>": {bug?: number, message?: string, diff?: string}}
//   → {branch, head, backup?, shas, mapping: {old: new}, dropped, empty, diffChanged: [old sha],
//      changedRevisions: number[], messageChangedRevisions: number[], conflict?, conflictLeft?, remaining?}
// interdiff <old-sha> <new-sha>
//   → {diff, method: "same-parent" | "old-rebased" | "new-rebased" | "diff-of-diffs"}
// check --base <ref> [--revisions <sha-to-D-number.json>] [--bugzilla-url <url>]
//   → {ok, failures: [{rule, message, sha?, title?}]}. Reads Bugzilla anonymously, never writes.
// summary <input.json | ->
//   input: {folder?, patches: [{id, title, bug, revision?, effort?, value?, repro?}], order?}
//   → {markdown, metaComment}

import { readFileSync } from "node:fs";
import { runCli, type Subcommand } from "../lib/cli.ts";
import { assemble, rewrite } from "./stack/build.ts";
import { check } from "./stack/check.ts";
import { detectDeps } from "./stack/deps.ts";
import { importStack } from "./stack/import.ts";
import { interdiff } from "./stack/interdiff.ts";
import { orderLandable, orderPatches, type OrderInput } from "./stack/order.ts";
import { summary, type SummaryInput } from "./stack/summary.ts";

export { assemble, rewrite } from "./stack/build.ts";
export { check } from "./stack/check.ts";
export { detectDeps } from "./stack/deps.ts";
export { importStack } from "./stack/import.ts";
export { interdiff } from "./stack/interdiff.ts";
export { orderLandable, orderPatches } from "./stack/order.ts";
export { summary } from "./stack/summary.ts";

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path === "-" ? 0 : path, "utf8")) as T;
}

function str(values: Record<string, unknown>, name: string): string {
  const v = values[name];
  if (typeof v !== "string" || !v) throw new Error(`--${name} is required`);
  return v;
}

const cwdOf = (values: Record<string, unknown>) => str(values, "cwd");

function onePositional(positionals: string[], what: string): string {
  if (positionals.length !== 1) throw new Error(`expected ${what}`);
  return positionals[0];
}

const subcommands: Record<string, Subcommand> = {
  import: async (pos, values) => importStack(cwdOf(values), onePositional(pos, "a revset")),
  assemble: async (pos, values) => {
    if (pos.length === 0) throw new Error("expected commits to cherry-pick");
    return assemble(cwdOf(values), {
      branch: str(values, "branch"),
      base: typeof values.base === "string" ? values.base : undefined,
      shas: pos,
      leaveConflict: !!values["leave-conflict"],
    });
  },
  deps: async (_pos, values) => detectDeps(cwdOf(values), str(values, "base")),
  order: async (pos, values) => {
    const input = readJson<OrderInput>(onePositional(pos, "an input file"));
    return values.landable ? orderLandable(input) : orderPatches(input);
  },
  rewrite: async (pos, values) => {
    const order = [...str(values, "order").split(","), ...pos].filter(Boolean);
    return rewrite(cwdOf(values), {
      base: str(values, "base"),
      order,
      edits: typeof values.edits === "string" ? readJson(values.edits) : undefined,
      branch: typeof values.branch === "string" ? values.branch : undefined,
      leaveConflict: !!values["leave-conflict"],
    });
  },
  interdiff: async (pos, values) => {
    if (pos.length !== 2) throw new Error("expected <old-sha> <new-sha>");
    return interdiff(cwdOf(values), pos[0], pos[1]);
  },
  check: async (_pos, values) =>
    check(cwdOf(values), str(values, "base"), {
      revisions: typeof values.revisions === "string" ? readJson(values.revisions) : undefined,
      bugzillaUrl: typeof values["bugzilla-url"] === "string" ? values["bugzilla-url"] : undefined,
    }),
  summary: async (pos) => summary(readJson<SummaryInput>(onePositional(pos, "an input file"))),
};

if (import.meta.main) {
  await runCli(subcommands, {
    cwd: { type: "string" },
    branch: { type: "string" },
    base: { type: "string" },
    order: { type: "string" },
    edits: { type: "string" },
    revisions: { type: "string" },
    "bugzilla-url": { type: "string" },
    "leave-conflict": { type: "boolean" },
    landable: { type: "boolean" },
  });
}
