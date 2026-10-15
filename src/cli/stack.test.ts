import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assemble, check, detectDeps, importStack, interdiff, rewrite } from "./stack.ts";
import { currentBranch, gitTry } from "./stack/git.ts";
import { lines, makeRepo, type TestRepo } from "./stack/testutil.ts";

const D = "Differential Revision: https://phabricator.services.mozilla.com/D";

// main: a.txt (20 lines), b.txt. Branch "work" on top:
//   A: a.txt line 2, B: a.txt line 2 again (needs A), C: b.txt, E: a.txt line 3 again after B (needs B).
async function fixture(): Promise<{ repo: TestRepo; base: string; A: string; B: string; C: string; E: string }> {
  const repo = await makeRepo();
  const base = await repo.commit({ "a.txt": lines(20), "b.txt": lines(5) }, "base");
  await repo.git(["checkout", "-q", "-b", "work"]);
  const A = await repo.commit({ "a.txt": lines(20, { 2: "A" }) }, `Bug XXXXXXX - Change line 2, r=alice.\n\n${D}101`);
  const B = await repo.commit({ "a.txt": lines(20, { 2: "B" }) }, "Bug 222 - Change line 2 again, r=bob,#group.");
  const C = await repo.commit({ "b.txt": lines(5, { 1: "C" }), "dir/test/test_c.js": "x\n" }, "Bug 333 - Change b, r=carol.");
  const E = await repo.commit({ "a.txt": lines(20, { 2: "B", 3: "E" }) }, "Bug 444 - Change line 3, r=dave.");
  return { repo, base, A, B, C, E };
}

test("import lists commits oldest first with parsed metadata", async (t) => {
  const { repo, A, C } = await fixture();
  t.after(() => repo.cleanup());
  const out = await importStack(repo.dir, "main..work");
  assert.equal(out.length, 4);
  assert.deepEqual(out[0], {
    sha: A,
    title: "Bug XXXXXXX - Change line 2, r=alice.",
    bug: null,
    reviewers: ["alice"],
    revision: 101,
    files: ["a.txt"],
    insertions: 1,
    deletions: 1,
    testOnly: false,
  });
  assert.equal(out[1].bug, 222);
  assert.deepEqual(out[1].reviewers, ["bob", "#group"]);
  assert.equal(out[2].sha, C);
  assert.deepEqual(out[2].files, ["b.txt", "dir/test/test_c.js"]);
  assert.equal(out[2].insertions, 2);
});

test("assemble creates and extends a branch, HEAD attached", async (t) => {
  const { repo, base, A, B, C } = await fixture();
  t.after(() => repo.cleanup());
  await repo.git(["checkout", "-q", "--detach", base]);
  const r1 = await assemble(repo.dir, { branch: "stack", base: "main", shas: [C, A] });
  assert.equal(r1.conflict, undefined);
  assert.equal(await currentBranch(repo.dir), "stack");
  assert.equal(r1.commits.length, 2);
  assert.notEqual(r1.commits[0].newSha, C); // C was rebased onto main
  assert.equal((await repo.git(["log", "--format=%s", "main..stack"])).trim().split("\n").length, 2);
  const r2 = await assemble(repo.dir, { branch: "stack", shas: [B] });
  assert.equal(r2.conflict, undefined);
  assert.equal((await repo.git(["show", "stack:a.txt"])).split("\n")[1], "B");
  assert.equal((await repo.git(["log", "--format=%an", "-1", "stack"])).trim(), "Test");
});

test("assemble skips commits already in the branch", async (t) => {
  const { repo, A } = await fixture();
  t.after(() => repo.cleanup());
  const r = await assemble(repo.dir, { branch: "work", shas: [A] });
  assert.deepEqual(r.skipped, [A]);
  assert.deepEqual(r.commits, []);
});

test("assemble conflict: aborted by default, left in progress with --leave-conflict", async (t) => {
  const { repo, base, B, C } = await fixture();
  t.after(() => repo.cleanup());
  await repo.git(["checkout", "-q", "--detach", base]);
  const r1 = await assemble(repo.dir, { branch: "stack", base: "main", shas: [C, B] });
  assert.deepEqual(r1.conflict, { sha: B, files: ["a.txt"] });
  assert.equal(r1.conflictLeft, false);
  assert.equal((await gitTry(repo.dir, ["rev-parse", "--verify", "--quiet", "refs/heads/stack"])).code, 1);
  assert.equal(await currentBranch(repo.dir), null); // untouched: still where it was

  const r2 = await assemble(repo.dir, { branch: "stack", base: "main", shas: [C, B], leaveConflict: true });
  assert.deepEqual(r2.conflict, { sha: B, files: ["a.txt"] });
  assert.equal(r2.conflictLeft, true);
  assert.equal(await currentBranch(repo.dir), "stack");
  assert.equal((await gitTry(repo.dir, ["rev-parse", "--verify", "--quiet", "CHERRY_PICK_HEAD"])).code, 0);
  await assert.rejects(assemble(repo.dir, { branch: "stack", shas: [B] }), /cherry-pick is in progress/);
});

test("deps finds direct hard deps only, and no deps for independent commits", async (t) => {
  const { repo, A, B, C, E } = await fixture();
  t.after(() => repo.cleanup());
  const deps = await detectDeps(repo.dir, "main");
  const pairs = deps.map((d) => [d.patch, d.needs, d.kind]);
  assert.deepEqual(pairs, [
    [B, A, "hard"],
    [E, B, "hard"],
  ]);
  assert.ok(deps.every((d) => d.source === "textual"));
  assert.match(deps[0].reason, /doesn't apply without .*Change line 2.*conflicts in a\.txt/);
  assert.ok(!pairs.some(([p]) => p === C));
  assert.equal(await currentBranch(repo.dir), "work");
});

test("deps: removing a manifest block needs the patch that edited it; far edits are independent", async (t) => {
  const repo = await makeRepo();
  t.after(() => repo.cleanup());
  await repo.commit({ "m.toml": "[a]\nskip-if = x\n[b]\n\n\n\n\n[c]\n" }, "base");
  await repo.git(["checkout", "-q", "-b", "work"]);
  const P = await repo.commit({ "m.toml": "[a]\nskip-if = x\nfail-if = y\n[b]\n\n\n\n\n[c]\n" }, "P");
  const Q = await repo.commit({ "m.toml": "[b]\n\n\n\n\n[c]\n" }, "Q");
  await repo.commit({ "m.toml": "[b]\n\n\n\n\n[c]\nskip-if = z\n" }, "R");
  const deps = await detectDeps(repo.dir, "main");
  assert.deepEqual(deps.map((d) => [d.patch, d.needs, d.kind]), [[Q, P, "hard"]]);
});

test("rewrite reorders, edits messages, keeps trailers and reports changed diffs", async (t) => {
  const { repo, base, A, B, C, E } = await fixture();
  t.after(() => repo.cleanup());
  const r = await rewrite(repo.dir, { base: "main", order: [C, A, B, E], edits: { [A]: { bug: 555 } } });
  assert.equal(r.conflict, undefined);
  assert.equal(await currentBranch(repo.dir), "work");
  assert.equal(r.shas.length, 4);
  assert.deepEqual(Object.keys(r.mapping), [C, A, B, E]);
  const msgA = await repo.git(["log", "-1", "--format=%B", r.mapping[A]]);
  assert.equal(msgA.trim(), `Bug 555 - Change line 2, r=alice.\n\n${D}101`);
  assert.deepEqual(r.messageChangedRevisions, [101]);
  assert.deepEqual(r.diffChanged, []); // nothing moved within diff context of another patch
  assert.deepEqual(r.changedRevisions, []);
  assert.equal((await repo.git(["rev-parse", "work"])).trim(), r.head);
  assert.equal((await repo.git(["rev-parse", r.backup!])).trim(), E);
  assert.equal((await repo.git(["rev-parse", `${r.shas[0]}^`])).trim(), base);
});

test("rewrite reuses unchanged commits and reports context changes as diff changes", async (t) => {
  const repo = await makeRepo();
  t.after(() => repo.cleanup());
  await repo.commit({ "a.txt": lines(20) }, "base");
  await repo.git(["checkout", "-q", "-b", "work"]);
  const X = await repo.commit({ "a.txt": lines(20, { 5: "X" }) }, `Bug 1 - X, r=a.\n\n${D}1`);
  const Y = await repo.commit({ "a.txt": lines(20, { 5: "X", 8: "Y" }) }, `Bug 2 - Y, r=a.\n\n${D}2`);
  const same = await rewrite(repo.dir, { base: "main", order: [X, Y] });
  assert.deepEqual(same.shas, [X, Y]);
  const r = await rewrite(repo.dir, { base: "main", order: [Y, X] });
  // Y's context had X's line; X's context now has Y's.
  assert.deepEqual(r.diffChanged, [Y, X]);
  assert.deepEqual(r.changedRevisions, [2, 1]);
  assert.equal(await repo.git(["show", "work:a.txt"]), lines(20, { 5: "X", 8: "Y" }));
});

test("rewrite conflict: branch untouched by default, cherry-pick left with the edited message", async (t) => {
  const { repo, A, B } = await fixture();
  t.after(() => repo.cleanup());
  const head = (await repo.git(["rev-parse", "work"])).trim();
  const r1 = await rewrite(repo.dir, { base: "main", order: [B, A] });
  assert.deepEqual(r1.conflict, { sha: B, files: ["a.txt"] });
  assert.equal(r1.conflictLeft, false);
  assert.equal(r1.backup, undefined);
  assert.equal((await repo.git(["rev-parse", "work"])).trim(), head);

  const r2 = await rewrite(repo.dir, { base: "main", order: [B, A], edits: { [B]: { message: "Bug 222 - Edited, r=bob." } }, leaveConflict: true });
  assert.equal(r2.conflictLeft, true);
  assert.deepEqual(r2.remaining, [A]);
  assert.equal(await currentBranch(repo.dir), "work");
  assert.equal((await repo.git(["rev-parse", "work"])).trim(), (await repo.git(["rev-parse", "main"])).trim());
  const mergeMsg = join(repo.dir, (await repo.git(["rev-parse", "--git-path", "MERGE_MSG"])).trim());
  assert.match(readFileSync(mergeMsg, "utf8"), /^Bug 222 - Edited, r=bob\./);
});

test("rewrite applies a suggested-edit diff and refuses a dirty worktree", async (t) => {
  const { repo, C, A } = await fixture();
  t.after(() => repo.cleanup());
  const diff = "--- a/b.txt\n+++ b/b.txt\n@@ -1,2 +1,2 @@\n-C\n+C2\n 2\n";
  const r = await rewrite(repo.dir, { base: "main", order: [C], edits: { [C]: { diff } } });
  assert.deepEqual(r.dropped.length, 3);
  assert.equal((await repo.git(["show", "work:b.txt"])).split("\n")[0], "C2");
  assert.deepEqual(r.diffChanged, [C]);
  writeFileSync(join(repo.dir, "b.txt"), "dirty\n");
  await assert.rejects(rewrite(repo.dir, { base: "main", order: [A] }), /uncommitted changes/);
});

test("interdiff ignores what the base contributed", async (t) => {
  const repo = await makeRepo();
  t.after(() => repo.cleanup());
  const base = await repo.commit({ "a.txt": lines(20) }, "base");
  const old = await repo.commit({ "a.txt": lines(20, { 2: "old" }) }, "old");
  await repo.git(["checkout", "-q", "--detach", base]);
  await repo.commit({ "a.txt": lines(20, { 18: "upstream" }) }, "upstream");
  const neu = await repo.commit({ "a.txt": lines(20, { 2: "new", 18: "upstream" }) }, "new");
  const r = await interdiff(repo.dir, old, neu);
  assert.equal(r.method, "old-rebased");
  assert.match(r.diff, /^-old$/m);
  assert.match(r.diff, /^\+new$/m);
  assert.doesNotMatch(r.diff, /^\+upstream$/m);
});

test("check reports every pre-submit problem", async (t) => {
  const repo = await makeRepo();
  t.after(() => repo.cleanup());
  await repo.commit({ "a.txt": "0\n" }, "base");
  await repo.git(["checkout", "-q", "-b", "work"]);
  const good = await repo.commit({ "a.txt": "1\n" }, `Bug 123 - Good, r=a.\n\n${D}9`);
  const noTrailer = await repo.commit({ "a.txt": "2\n" }, "Bug 999 - Private bug, r=a,#b.");
  const wip = await repo.commit({ "a.txt": "3\n" }, "WIP - not done");
  const placeholder = await repo.commit({ "a.txt": "4\n" }, "Bug XXXXXXX - Placeholder, r=a.");
  const badFormat = await repo.commit({ "a.txt": "5\n" }, "Bug 123 - No reviewer");
  const urls: string[] = [];
  const fakeFetch = (async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify({ bugs: [{ id: 123 }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await check(repo.dir, "main", { fetch: fakeFetch, revisions: { [good]: 9, [noTrailer]: 10 } });
  assert.equal(r.ok, false);
  const got = r.failures.map((f) => [f.rule, f.sha]);
  assert.deepEqual(got, [
    ["missing-trailer", noTrailer],
    ["wip", wip],
    ["title-format", wip],
    ["placeholder", placeholder],
    ["title-format", placeholder],
    ["title-format", badFormat],
    ["bug-not-public", noTrailer],
  ]);
  assert.deepEqual(urls, ["https://bugzilla.mozilla.org/rest/bug?id=123,999&include_fields=id"]);

  await repo.git(["reset", "-q", "--hard", good]);
  const ok = await check(repo.dir, "main", { fetch: fakeFetch, revisions: { [good]: 9 } });
  assert.deepEqual(ok, { ok: true, failures: [] });
  await repo.git(["checkout", "-q", "--detach"]);
  const detached = await check(repo.dir, "main", { fetch: fakeFetch });
  assert.deepEqual(detached.failures.map((f) => f.rule), ["detached-head"]);
});

test("CLI: one JSON document on stdout, error JSON with exit 1", async (t) => {
  const repo = await makeRepo();
  t.after(() => repo.cleanup());
  const input = join(repo.dir, "order.json");
  writeFileSync(input, JSON.stringify({ patches: [{ id: "a", effort: 2 }, { id: "b", effort: 1 }], deps: [] }));
  const cli = join(import.meta.dirname, "stack.ts");
  const out = execFileSync(process.execPath, [cli, "order", input], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(out), { order: ["b", "a"], flippedSoftDeps: [] });
  let failed: { status: number; stdout: string } | undefined;
  try {
    execFileSync(process.execPath, [cli, "deps"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    failed = e as { status: number; stdout: string };
  }
  assert.equal(failed?.status, 1);
  assert.deepEqual(JSON.parse(failed!.stdout), { error: "--cwd is required" });
});
