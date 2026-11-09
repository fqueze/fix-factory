// The commits a try push carries beyond central, as commits of a local branch: hg.mozilla.org serves each one as a
// patch (raw-rev). The try selection's own commit (only try_task_config.json) is left out. A request whose fixes
// need them (the jobs they add: mochitest-repeat) has its stack pushed to try with them on top.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execOk } from "../lib/exec.ts";

const TREEHERDER = "https://treeherder.mozilla.org/api/project/try/push/";
const RAW = "https://hg.mozilla.org/try/raw-rev/";

export interface HgPatch {
  node: string;
  user: string; // "Name <email>"
  date: string; // "<unix seconds> <tz offset>"
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
export async function importPush(repo: string, rev: string, base: string, branch: string, fetchFn: typeof fetch = fetch): Promise<{ branch: string; shas: string[] }> {
  const patches = await pushPatches(rev, fetchFn);
  const dir = mkdtempSync(join(tmpdir(), "try-import-"));
  const wt = join(dir, "wt");
  await execOk(["git", "worktree", "add", "--detach", wt, base], { cwd: repo });
  try {
    const shas: string[] = [];
    for (const p of patches) {
      const file = join(dir, `${p.node}.diff`);
      writeFileSync(file, p.diff.endsWith("\n") ? p.diff : p.diff + "\n");
      await execOk(["git", "apply", "--index", "--3way", file], { cwd: wt });
      const [, name, email] = /^(.*?)\s*<([^>]*)>$/.exec(p.user) ?? [, p.user, ""];
      const when = p.date.split(" ")[0];
      await execOk(["git", "-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-q", "-m", p.message], {
        cwd: wt,
        env: { ...process.env, GIT_AUTHOR_NAME: name!, GIT_AUTHOR_EMAIL: email!, GIT_AUTHOR_DATE: `@${when}` },
      });
      shas.push((await execOk(["git", "rev-parse", "HEAD"], { cwd: wt })).trim());
    }
    await execOk(["git", "branch", "-f", branch, "HEAD"], { cwd: wt });
    return { branch, shas };
  } finally {
    await execOk(["git", "worktree", "remove", "--force", wt], { cwd: repo });
    rmSync(dir, { recursive: true, force: true });
  }
}
