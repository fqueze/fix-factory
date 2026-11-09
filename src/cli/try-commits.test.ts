import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHgPatch, pushPatches } from "./try-commits.ts";

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
