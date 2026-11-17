import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execOk } from "../lib/exec.ts";
import { importPush, parseHgPatch, pushPatches } from "./try-commits.ts";

const patch = (node: string, file: string, message: string) =>
  `# HG changeset patch\n# User Florian Quèze <florian@queze.net>\n# Date 1794177261 0\n# Node ID ${node}\n# Parent  0000\n${message}\n\ndiff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-a\n+b\n`;

test("parseHgPatch reads an hg export: author, date, message, files", () => {
  const p = parseHgPatch(patch("aaa", "testing/a.py", "Bug 1 - Add repeat jobs, r=ahal.\n\nBody."));
  assert.deepEqual([p.node, p.user, p.date, p.message, p.files], ["aaa", "Florian Quèze <florian@queze.net>", "1794177261 0", "Bug 1 - Add repeat jobs, r=ahal.\n\nBody.", ["testing/a.py"]]);
  assert.match(p.diff, /^diff --git a\/testing\/a.py/);
});

test("pushPatches gives a try push's commits oldest first, without its try selection's", async () => {
  const fake = (async (url: string) => {
    if (url.includes("treeherder")) return new Response(JSON.stringify({ results: [{ revisions: [{ revision: "ccc" }, { revision: "bbb" }, { revision: "aaa" }] }] }));
    const node = url.split("/").pop()!;
    return new Response(node === "ccc" ? patch("ccc", "try_task_config.json", "Fuzzy query=x") : patch(node, `f-${node}`, `Bug 1 - ${node}`));
  }) as typeof fetch;
  assert.deepEqual((await pushPatches("ccc", fake)).map((p) => p.node), ["aaa", "bbb"]);
});

test("importPush leaves out the push's commits that landed since, under their reviewed title", async () => {
  const repo = mkdtempSync(join(tmpdir(), "import-push-"));
  try {
    const git = (...args: string[]) => execOk(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
    await git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "f-aaa"), "a\n");
    writeFileSync(join(repo, "f-bbb"), "a\n");
    await git("add", ".");
    await git("commit", "-q", "-m", "base");
    // aaa landed, its reviewers in its title.
    writeFileSync(join(repo, "f-aaa"), "b\n");
    await git("commit", "-q", "-am", "Bug 1 - aaa, r=ahal,mozbase-reviewers.");
    const fake = (async (url: string) => {
      if (url.includes("treeherder")) return new Response(JSON.stringify({ results: [{ revisions: [{ revision: "bbb" }, { revision: "aaa" }] }] }));
      const node = url.split("/").pop()!;
      return new Response(patch(node, `f-${node}`, node === "aaa" ? "WIP: Bug 1 - aaa" : "Bug 1 - bbb"));
    }) as typeof fetch;
    const r = await importPush(repo, "bbb", "main", "try-with", fake);
    assert.deepEqual(r.landed, ["aaa"]);
    assert.equal(r.shas.length, 1);
    assert.equal((await git("log", "-1", "--format=%s", "try-with")).trim(), "Bug 1 - bbb");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("importPush leaves out a commit whose change central already has under another title, and takes one that doesn't apply as made on the push's own base", async () => {
  const repo = mkdtempSync(join(tmpdir(), "import-push-"));
  try {
    const git = (...args: string[]) => execOk(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
    await git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "f-aaa"), "a\n");
    writeFileSync(join(repo, "f-bbb"), "a\n");
    await git("add", ".");
    await git("commit", "-q", "-m", "base");
    const pushBase = (await git("rev-parse", "HEAD")).trim();
    writeFileSync(join(repo, "f-aaa"), "b\n");
    writeFileSync(join(repo, "f-bbb"), "c\n");
    await git("commit", "-q", "-am", "Bug 2 - Something else entirely, r=x.");
    let mapped = true;
    const fake = (async (url: string) => {
      if (url.includes("treeherder")) return new Response(JSON.stringify({ results: [{ revisions: [{ revision: "bbb" }, { revision: "aaa" }] }] }));
      if (url.includes("hg2git")) return mapped ? new Response(JSON.stringify({ git_hash: pushBase, hg_hash: "0000" })) : new Response("{}", { status: 404 });
      const node = url.split("/").pop()!;
      return new Response(patch(node, `f-${node}`, `WIP: ${node}`));
    }) as typeof fetch;
    // aaa (a to b) is there; bbb (a to b) doesn't apply, f-bbb being c: it's taken as made on the push's base.
    const r = await importPush(repo, "bbb", "main", "try-with", fake);
    assert.deepEqual([r.landed, r.onPushBase, r.shas.length], [["aaa"], ["bbb"], 1]);
    assert.equal((await git("rev-parse", `${r.shas[0]}~2`)).trim(), pushBase, "on the push's base, after the push's earlier commit");
    assert.equal((await git("rev-parse", "try-with-own-base")).trim(), r.shas[0], "kept from gc");
    mapped = false;
    await assert.rejects(importPush(repo, "bbb", "main", "try-with", fake), /^Error: bbb "WIP: bbb" of try push bbb doesn't apply on today's main \(f-bbb\), nor on the push's own base \(hg2git 0000: HTTP 404\)/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
