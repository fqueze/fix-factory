import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execOk } from "../lib/exec.ts";
import { bugOfSubject, bugsOfComment, list, logArgs, parseFirstCommit, parseManifest } from "./annotations.ts";

const manifest = readFileSync(new URL("../../test/fixtures/annotations/browser.toml", import.meta.url), "utf8");

test("parseManifest: sections, multi-line and single-line arrays, comments, escapes", () => {
  const a = parseManifest(manifest);
  assert.equal(a.length, 14);
  assert.deepEqual(a[0], { test: "DEFAULT", kind: "skip-if", condition: "os == 'android'", comment: "Bug 1500000", line: 3, lineText: `"os == 'android'", # Bug 1500000` });
  assert.deepEqual(
    a.filter((x) => x.test === "browser_async_remove_tab.js").map((x) => [x.line, x.comment]),
    [
      [25, "Bug 1787024"],
      [26, "Bug 1787024"],
      [27, "Bug 1787024"],
    ],
  );
  const single = a.filter((x) => x.test === "browser_single_line.js");
  assert.deepEqual(
    single.map((x) => [x.condition, x.comment, x.lineText]),
    [
      ["os == 'android'", "Bug 1780219", `skip-if = ["os == 'android'", "tsan"] # Bug 1780219`],
      ["tsan", "Bug 1780219", `skip-if = ["os == 'android'", "tsan"] # Bug 1780219`],
    ],
  );
  const fail = a.filter((x) => x.kind === "fail-if");
  assert.deepEqual(
    fail.map((x) => x.condition),
    ['os == "win"', 'a11y_checks && "quoted"'],
  );
  assert.ok(!a.some((x) => x.condition === "crashreporter"), "run-if is not an annotation");
  assert.deepEqual(a.at(-1), { test: "test_query.html?a=b", kind: "skip-if", condition: "debug", line: 53, lineText: 'skip-if = "debug"' });
});

test("commit and bug helpers", () => {
  assert.deepEqual(logArgs(`"tsan", # Bug 1`, "a/b.toml"), ["log", "--reverse", "--format=%H%x09%aI%x09%an%x09%s", "-S", `"tsan", # Bug 1`, "--", "a/b.toml"]);
  assert.deepEqual(parseFirstCommit("abc\t2026-01-01T00:00:00+00:00\tA B\tBug 12345 - x\ndef\t...\n"), {
    sha: "abc",
    date: "2026-01-01T00:00:00+00:00",
    author: "A B",
    subject: "Bug 12345 - x",
  });
  assert.equal(parseFirstCommit("\n"), null);
  assert.equal(bugOfSubject("Bug 1787024 - Skip it, r=a."), 1787024);
  assert.equal(bugOfSubject("Backed out changeset abc"), null);
  assert.deepEqual(bugsOfComment("bug 123456 and Bug 234567, Bug 123456"), [123456, 234567]);
  assert.deepEqual(bugsOfComment(undefined), []);
});

test("list: first commit adding each condition line, with its bug from Bugzilla", async () => {
  const repo = mkdtempSync(join(tmpdir(), "annotations-test-"));
  try {
    const git = (...args: string[]) => execOk(["git", "-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { cwd: repo });
    await git("init", "-q");
    mkdirSync(join(repo, "dir/test"), { recursive: true });
    const path = join(repo, "dir/test/browser.toml");
    writeFileSync(path, '["browser_a.js"]\nskip-if = [\n  "tsan", # Bug 1111111\n]\n');
    await git("add", ".");
    await git("commit", "-qm", "Bug 2222222 - Skip browser_a.js on tsan, r=x.");
    writeFileSync(path, '["browser_a.js"]\nskip-if = [\n  "tsan", # Bug 1111111\n  "asan",\n]\n');
    await git("commit", "-qam", "Bug 3333333 - Skip browser_a.js on asan too, r=x.");
    writeFileSync(join(repo, "dir/Cargo.toml"), '[package]\nskip-if = ["not a manifest"]\n');

    const urls: string[] = [];
    const fakeFetch = (async (url: string) => {
      urls.push(url);
      const id = /bug\/(\d+)/.exec(url)![1];
      if (id === "3333333") return new Response(JSON.stringify({ error: true, message: "private" }), { status: 401 });
      if (url.includes("/comment")) return new Response(JSON.stringify({ bugs: { [id]: { comments: [{ text: `about ${id}` }] } } }));
      return new Response(JSON.stringify({ bugs: [{ id: Number(id), summary: `summary ${id}` }] }));
    }) as typeof fetch;

    const out = await list("dir", repo, { fetch: fakeFetch });
    assert.equal(out.length, 2);
    const [tsan, asan] = out;
    assert.equal(tsan.manifest, "dir/test/browser.toml");
    assert.equal(tsan.condition, "tsan");
    assert.equal(tsan.comment, "Bug 1111111");
    assert.equal(tsan.commit?.subject, "Bug 2222222 - Skip browser_a.js on tsan, r=x.");
    assert.deepEqual(tsan.bug, { id: 2222222, summary: "summary 2222222", firstComment: "about 2222222" });
    assert.deepEqual(tsan.commentBugs, [{ id: 1111111, summary: "summary 1111111", firstComment: "about 1111111" }]);
    assert.equal(asan.commit?.subject, "Bug 3333333 - Skip browser_a.js on asan too, r=x.");
    assert.deepEqual(asan.bug, { id: 3333333, error: "Bugzilla bug/3333333?include_fields=id,summary: private" });
    assert.equal(asan.comment, undefined);
    assert.deepEqual(asan.commentBugs, []);
    assert.equal(new Set(urls).size, urls.length, "each bug is fetched once");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
