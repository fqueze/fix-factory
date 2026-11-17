// The commits a try push carries beyond central, as commits of a local branch: hg.mozilla.org serves each one as a
// patch (raw-rev). The try selection's own commit (only try_task_config.json) is left out. A request whose fixes
// need them (the jobs they add: mochitest-repeat) has its stack pushed to try with them on top.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execOk } from "../lib/exec.ts";

const TREEHERDER = "https://treeherder.mozilla.org/api/project/try/push/";
const RAW = "https://hg.mozilla.org/try/raw-rev/";
const HG2GIT = "https://lando.moz.tools/api/hg2git/firefox/";

export interface HgPatch {
  node: string;
  user: string; // "Name <email>"
  date: string; // "<unix seconds> <tz offset>"
  parent: string; // its first parent's hg node
  message: string;
  files: string[];
  diff: string;
}

export function parseHgPatch(text: string): HgPatch {
  const lines = text.split("\n");
  const header = (k: string) => lines.find((l) => l.startsWith(`# ${k} `))?.slice(k.length + 3).trim() ?? "";
  const first = lines.findIndex((l) => l.trim() !== "" && !l.startsWith("#"));
  const diffAt = lines.findIndex((l) => l.startsWith("diff --git "));
  if (first < 0 || diffAt < 0) throw new Error("not an hg export patch");
  return {
    node: header("Node ID"),
    user: header("User"),
    date: header("Date"),
    parent: header("Parent").split(/\s+/)[0],
    message: lines.slice(first, diffAt).join("\n").trim(),
    files: lines.filter((l) => l.startsWith("diff --git ")).map((l) => l.split(" b/").pop()!),
    diff: lines.slice(diffAt).join("\n"),
  };
}

// Oldest first, without the try selection's commit.
export async function pushPatches(rev: string, fetchFn: typeof fetch = fetch): Promise<HgPatch[]> {
  const res = await fetchFn(`${TREEHERDER}?revision=${rev}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`treeherder: HTTP ${res.status}`);
  const push = ((await res.json()) as { results: { revisions: { revision: string }[] }[] }).results[0];
  if (!push) throw new Error(`no try push ${rev}`);
  const patches: HgPatch[] = [];
  for (const { revision } of [...push.revisions].reverse()) {
    const r = await fetchFn(RAW + revision);
    if (!r.ok) throw new Error(`${RAW}${revision}: HTTP ${r.status}`);
    const p = parseHgPatch(await r.text());
    if (p.files.every((f) => f === "try_task_config.json")) continue;
    patches.push(p);
  }
  return patches;
}

// The push's commits on `base`, as `branch` (replaced if it exists), made in a worktree of its own that goes after.
// A commit's title without its reviewers: what it lands as, whatever its review gave it.
const titleOf = (message: string) => message.split("\n")[0].replace(/^WIP:\s*/i, "").replace(/,?\s*r[=?][^ ]*\.?$/, "").trim();

// A commit of the push that landed since (the push came before its landing): left out, base has it. One that doesn't
// apply on base, central having changed the same lines since, is the commit as made on the push's own base (`onPushBase`):
// cherry-picked onto the stack, its conflict goes to resolve-conflict like a patch's.
export async function importPush(repo: string, rev: string, base: string, branch: string, fetchFn: typeof fetch = fetch): Promise<{ branch: string; shas: string[]; landed: string[]; onPushBase: string[] }> {
  const patches = await pushPatches(rev, fetchFn);
  const dir = mkdtempSync(join(tmpdir(), "try-import-"));
  const wt = join(dir, "wt");
  await execOk(["git", "worktree", "add", "--detach", wt, base], { cwd: repo });
  // The push's commits on its own base, each node's sha, made once one is needed.
  let own: Map<string, string> | undefined;
  const onOwnBase = async (): Promise<Map<string, string>> => {
    if (own) return own;
    const res = await fetchFn(HG2GIT + patches[0].parent, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`hg2git ${patches[0].parent.slice(0, 12)}: HTTP ${res.status}`);
    const parent = ((await res.json()) as { git_hash: string }).git_hash;
    if (!(await execOk(["git", "cat-file", "-e", `${parent}^{commit}`], { cwd: repo }).then(() => true, () => false))) await execOk(["git", "fetch", "-q", "origin", parent], { cwd: repo });
    const owt = join(dir, "own");
    await execOk(["git", "worktree", "add", "--detach", owt, parent], { cwd: repo });
    try {
      own = new Map();
      for (const p of patches) {
        await execOk(["git", "apply", "--index", join(dir, `${p.node}.diff`)], { cwd: owt });
        await commit(p, owt);
        own.set(p.node, (await execOk(["git", "rev-parse", "HEAD"], { cwd: owt })).trim());
      }
      // Kept from gc while the stack's pushes cherry-pick them.
      await execOk(["git", "branch", "-f", `${branch}-own-base`, "HEAD"], { cwd: owt });
      return own;
    } finally {
      await execOk(["git", "worktree", "remove", "--force", owt], { cwd: repo });
    }
  };
  const commit = async (p: HgPatch, cwd: string) => {
    const [, name, email] = /^(.*?)\s*<([^>]*)>$/.exec(p.user) ?? [, p.user, ""];
    const when = p.date.split(" ")[0];
    await execOk(["git", "-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-q", "-m", p.message], {
      cwd,
      env: { ...process.env, GIT_AUTHOR_NAME: name!, GIT_AUTHOR_EMAIL: email!, GIT_AUTHOR_DATE: `@${when}` },
    });
  };
  try {
    for (const p of patches) writeFileSync(join(dir, `${p.node}.diff`), p.diff.endsWith("\n") ? p.diff : p.diff + "\n");
    const shas: string[] = [];
    const landed: string[] = [];
    const onPushBase: string[] = [];
    const oldest = Math.min(...patches.map((p) => Number(p.date.split(" ")[0])));
    const baseTitles = patches.length ? new Set((await execOk(["git", "log", "--format=%s", `--since=@${oldest}`, "HEAD"], { cwd: wt })).split("\n").map(titleOf)) : new Set<string>();
    for (const p of patches) {
      const file = join(dir, `${p.node}.diff`);
      if (baseTitles.has(titleOf(p.message))) {
        landed.push(p.node);
        continue;
      }
      try {
        await execOk(["git", "apply", "--index", "--3way", file], { cwd: wt });
      } catch (e) {
        // Landed since under another title: central has its change already (it applies in reverse). An earlier version of
        // what landed isn't left out: what it does beyond it may be what the push needs.
        await execOk(["git", "reset", "-q", "--hard"], { cwd: wt });
        if (!(await execOk(["git", "apply", "-R", "--check", file], { cwd: wt }).then(() => true, () => false))) {
          const ownSha = (await onOwnBase().catch((err: unknown) => {
            const failed = [...String(e instanceof Error ? e.message : e).matchAll(/error: patch failed: (\S+?):\d+/g)].map((m) => m[1]);
            throw new Error(
              `${p.node.slice(0, 12)} "${p.message.split("\n")[0]}" of try push ${rev.slice(0, 12)} doesn't apply on today's ${base}${failed.length ? ` (${[...new Set(failed)].join(", ")})` : ""}, nor on the push's own base (${err instanceof Error ? err.message : err}). Push again with commits that apply on today's ${base}, or drop the request's tryWith if what they add has landed.`,
            );
          })).get(p.node)!;
          shas.push(ownSha);
          onPushBase.push(p.node);
          continue;
        }
        landed.push(p.node);
        continue;
      }
      await commit(p, wt);
      shas.push((await execOk(["git", "rev-parse", "HEAD"], { cwd: wt })).trim());
    }
    await execOk(["git", "branch", "-f", branch, "HEAD"], { cwd: wt });
    return { branch, shas, landed, onPushBase };
  } finally {
    await execOk(["git", "worktree", "remove", "--force", wt], { cwd: repo });
    rmSync(dir, { recursive: true, force: true });
  }
}
