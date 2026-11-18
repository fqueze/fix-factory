import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildAnnotations, gitIn, lineMapper, parseEntries } from "./review-annotations.ts";
import { fingerprinter, normalizeMessage } from "../lib/fingerprint.ts";
import { foldEvents } from "../state/fold.ts";
import type { Event } from "../types.ts";

// A repo with two versions of one patch on the same base: the second adds two lines above, changes line 4, rewords its
// message's second paragraph.
let dir: string;
let v1: string;
let v2: string;
let v3: string;
const git = (...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i + 1)).join("\n") + "\n";

before(() => {
  dir = mkdtempSync(join(tmpdir(), "ff-annotations-"));
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.js"), lines(10, (i) => `base ${i}`));
  git("add", ".");
  git("commit", "-qm", "base");
  writeFileSync(join(dir, "a.js"), lines(10, (i) => `line ${i}`));
  git("commit", "-qam", "Bug XXXXXXX - Fix a, r=smaug.\n\nKeep the cache.\nWait for it.");
  v1 = git("rev-parse", "HEAD");
  git("checkout", "-q", "HEAD^");
  writeFileSync(join(dir, "a.js"), "new 1\nnew 2\n" + lines(10, (i) => (i === 4 ? "changed 4" : `line ${i}`)));
  git("commit", "-qam", "Bug 123 - Fix a, r=smaug.\n\nKeep the cache longer.\nWait for it.");
  v2 = git("rev-parse", "HEAD");
  // v1 rebased on another base, its bug number given, submitted: the same fingerprint.
  git("checkout", "-q", "-b", "rebased", `${v1}^`);
  writeFileSync(join(dir, "b.js"), "other\n");
  git("add", ".");
  git("commit", "-qm", "other");
  git("cherry-pick", v1);
  git("commit", "-q", "--amend", "-m", "Bug 123 - Fix a, r=smaug,mak.\n\nKeep the cache.\nWait for it.\n\nDifferential Revision: https://phabricator.services.mozilla.com/D1");
  v3 = git("rev-parse", "HEAD");
});

after(() => rmSync(dir, { recursive: true, force: true }));

describe("fingerprints", () => {
  it("keep a patch rebased, given its bug number, r= and revision; not one whose code or message changed", () => {
    const fp = fingerprinter(dir);
    assert.equal(fp(v1), fp(v3));
    assert.notEqual(fp(v1), fp(v2));
    assert.equal(fp("f".repeat(40)), undefined);
    assert.equal(normalizeMessage("Bug 123 - Fix, r=a.\n\nBody\n\nDifferential Revision: https://x/D1\n"), "Bug - Fix\n\nBody");
  });
});

describe("lineMapper", () => {
  it("carries a line through the diff between two versions, outdated when it changed or its file isn't in the patch", () => {
    const m = lineMapper(gitIn(dir));
    assert.deepEqual(m.carry({ file: "a.js", line: 7, side: "new" }, v1, v2), { file: "a.js", line: 9, side: "new" });
    assert.equal(m.carry({ file: "a.js", line: 4, side: "new" }, v1, v2), undefined);
    assert.deepEqual(m.carry({ file: "a.js", line: [5, 6] }, v1, v2), { file: "a.js", line: [7, 8] });
    assert.equal(m.carry({ file: "gone.js", line: 1 }, v1, v2), undefined);
    assert.deepEqual(m.carry({ file: "a.js" }, v1, v2), { file: "a.js" });
  });

  it("finds a commit message's lines in the new message, and a section's lines in its new text", () => {
    const m = lineMapper(gitIn(dir));
    assert.deepEqual(m.carry({ file: "(commit)", line: 4 }, v1, v2), { file: "(commit)", line: 4 });
    assert.equal(m.carry({ file: "(commit)", line: 3 }, v1, v2), undefined, "reworded");
    assert.deepEqual(m.carry({ file: "(section:test-plan)", line: 1 }, v1, v2, ["Green on try."], "Ran it.\nGreen on try."), { file: "(section:test-plan)", line: 2 });
    assert.equal(m.carry({ file: "(section:test-plan)", line: 1 }, v1, v2, ["Green on try."], "Red."), undefined);
  });
});

describe("parseEntries", () => {
  it("reads where each comment of an older stack-viewer's text is, and the comment without its quote", () => {
    const text =
      '- a.js:7 — "line 7"\n\n  ```diff\n   line 6\n  +line 7\n  ```\n\n  Why here?\n\n' +
      '- the commit message, line 3 — "Keep the cache."\n\n  ```\n  Keep the cache.\n  ```\n\n  Say why.\n  Really.\n\n' +
      '- a.js:2 (line number in the original file) — "x"\n\n  Gone?\n';
    assert.deepEqual(parseEntries(text), [
      { anchor: { file: "a.js", line: 7, side: "new" }, body: "Why here?" },
      { anchor: { file: "(commit)", line: 3 }, body: "Say why.\nReally." },
      { anchor: { file: "a.js", line: 2, side: "old" }, body: "Gone?" },
    ]);
    assert.deepEqual(parseEntries("Should it remove the skip-if?"), [{ anchor: { file: "(commit)" }, body: "Should it remove the skip-if?" }]);
  });
});

describe("buildAnnotations", () => {
  it("gives each commit its status, actions, bug link, test plan and earlier comments carried to it", () => {
    const R = "r-1";
    const t = "2026-11-17T10:00:00.000Z";
    const e = (x: object) => ({ v: 1, t, request: R, ...x }) as Event;
    const draft = { product: "Core", component: "DOM", summary: "s", description: "d" };
    const events: Event[] = [
      e({ type: "request-created", kind: "burndown", text: "" }),
      e({ type: "item-created", item: "i-a", folder: "a", group: { message: "m", tests: ["a.js"], configs: [] } }),
      e({ type: "patch", patch: "p-a", item: "i-a", sha: v1, worktree: dir, title: "Bug XXXXXXX - Fix a, r=smaug.", bug: null, bugDraft: draft }),
      e({ type: "comment-sent", patch: "p-a", text: '- a.js:7 — "line 7"\n\n  Why here?\n', key: "author:i-a:comment:c-1" }),
      e({ type: "patch-approved", patch: "p-a", sha: v1, fingerprint: "old" }),
      e({ type: "patch", patch: "p-a", item: "i-a", sha: v2, worktree: dir, title: "Bug XXXXXXX - Fix a, r=smaug.", bug: null, bugDraft: draft }),
      e({ type: "test-plan", patch: "p-a", text: "Green on try." }),
      e({ type: "review-status", patch: "p-a", revision: 7, status: "needs-review", reviewers: [], comments: [{ id: 41, author: "smaug", file: "a.js", line: 4, text: "Why?", done: false }], diff: { id: 1, commit: v1, created: t } }),
      e({ type: "reply-draft", patch: "p-a", commentId: 41, text: "Because." }),
      e({ type: "comment-response", patch: "p-a", comment: "phab-41", response: "ignore" }),
    ];
    const r = foldEvents(events);
    const all = buildAnnotations(r, { [v2]: "p-a" }, { git: gitIn(dir), fingerprint: fingerprinter(dir), report: () => undefined, bugUrl: () => "https://bugzilla/enter" }, "Repeat failures");
    assert.equal(all.title, "Repeat failures", "the stack's name, for stack-viewer's header");
    const a = all.commits[v2];
    assert.equal(a.draftKey, "r-1:p-a", "drafts outlive the commit's sha");
    assert.deepEqual(a.status, { kind: "changed", label: "Changed since you approved it" });
    assert.deepEqual(a.actions.map((x) => x.id), ["approve", "set-bug"]);
    assert.deepEqual(a.titleLinks.map((x) => [x.text, x.href]), [["Bug XXXXXXX", "https://bugzilla/enter"]]);
    assert.deepEqual(a.sections, [{ id: "test-plan", title: "Test plan", markdown: "Green on try." }]);
    const [yours, phab] = a.comments;
    assert.deepEqual([yours.id, yours.author, yours.anchor, yours.outdated, yours.state, yours.body, yours.responses], [r.patches["p-a"].yourComments![0].id, "you", { file: "a.js", line: 9, side: "new" }, false, "open", "Why here?", ["done", "reply"]]);
    assert.deepEqual([phab.id, phab.author, phab.outdated, phab.state, phab.draftReply, phab.sourceUrl, phab.responses], ["phab-41", "smaug (Phabricator)", true, "ignored", "Because.", "https://phabricator.services.mozilla.com/D7#inline-41", ["address", "reply", "ignore"]]);
  });
});
