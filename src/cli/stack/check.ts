import { currentBranch, gitTry, readCommit, revList, revParse, title } from "./git.ts";
import { PLACEHOLDER_RE, TITLE_FORMAT_RE, parseBug, parseRevision } from "./message.ts";

export interface CheckFailure {
  rule: "detached-head" | "cherry-pick-in-progress" | "empty-stack" | "wip" | "placeholder" | "title-format" | "bug-not-public" | "bugzilla" | "missing-trailer" | "wrong-trailer";
  message: string;
  sha?: string;
  title?: string;
}

export interface CheckOptions {
  revisions?: Record<string, number>; // sha → D-number, for patches already submitted
  fetch?: typeof fetch; // injectable for tests
  bugzillaUrl?: string;
}

const BUGZILLA = "https://bugzilla.mozilla.org";

// Pre-submit checks on base..HEAD. Bugzilla is only read: an anonymous search returns public bugs
// only, so a bug missing from the answer doesn't exist or is private.
export async function check(cwd: string, base: string, opts: CheckOptions = {}): Promise<{ ok: boolean; failures: CheckFailure[] }> {
  const failures: CheckFailure[] = [];
  if (!(await currentBranch(cwd))) {
    failures.push({ rule: "detached-head", message: "HEAD is detached; moz-phab needs a branch" });
  }
  if ((await gitTry(cwd, ["rev-parse", "--verify", "--quiet", "CHERRY_PICK_HEAD"])).code === 0) {
    failures.push({ rule: "cherry-pick-in-progress", message: "a cherry-pick is in progress" });
  }
  const revisions = new Map<string, number>();
  for (const [ref, rev] of Object.entries(opts.revisions ?? {})) {
    revisions.set(await revParse(cwd, ref), rev);
  }
  const shas = await revList(cwd, [`${await revParse(cwd, base)}..HEAD`]);
  if (shas.length === 0) {
    failures.push({ rule: "empty-stack", message: `no commits between ${base} and HEAD` });
  }
  const bugs = new Map<number, { sha: string; title: string }[]>();
  for (const sha of shas) {
    const message = (await readCommit(cwd, sha)).message;
    const t = title(message);
    const fail = (rule: CheckFailure["rule"], msg: string) => failures.push({ rule, message: msg, sha, title: t });
    if (/^(WIP|DEBUG)\b/i.test(t)) fail("wip", "WIP or DEBUG commit");
    if (message.match(PLACEHOLDER_RE)) fail("placeholder", "the message still says Bug XXXXXXX");
    if (!TITLE_FORMAT_RE.test(t)) fail("title-format", 'the title must look like "Bug N - Description, r=reviewer."');
    const bug = parseBug(t);
    if (bug !== null) bugs.set(bug, [...(bugs.get(bug) ?? []), { sha, title: t }]);
    const expected = revisions.get(sha);
    const actual = parseRevision(message);
    if (expected !== undefined && actual === undefined) fail("missing-trailer", `missing "Differential Revision: …/D${expected}"`);
    if (expected !== undefined && actual !== undefined && actual !== expected) fail("wrong-trailer", `trailer says D${actual}, expected D${expected}`);
  }
  if (bugs.size > 0) {
    const url = `${opts.bugzillaUrl ?? BUGZILLA}/rest/bug?id=${[...bugs.keys()].join(",")}&include_fields=id`;
    try {
      const res = await (opts.fetch ?? fetch)(url, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const found = new Set(((await res.json()) as { bugs: { id: number }[] }).bugs.map((b) => b.id));
      for (const [bug, uses] of bugs) {
        if (found.has(bug)) continue;
        for (const u of uses) failures.push({ rule: "bug-not-public", message: `bug ${bug} doesn't exist or isn't public`, ...u });
      }
    } catch (e) {
      failures.push({ rule: "bugzilla", message: `couldn't check the bugs on Bugzilla: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  return { ok: failures.length === 0, failures };
}
