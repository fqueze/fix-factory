import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyArtifacts, gitDirFor, keptPath } from "./kept.ts";

test("a removed worktree's paths are read from its kept copy, its commits from the main checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "kept-test-"));
  try {
    const dirs = { stateDir: "/state", worktreesDir: join(root, "wt"), firefoxRepo: "/ff" };
    assert.equal(keptPath(dirs, root), root, "still there");
    assert.equal(keptPath(dirs, join(root, "wt/a")), "/state/kept/a");
    assert.equal(keptPath(dirs, join(root, "wt/a/artifacts/x.md")), "/state/kept/a/artifacts/x.md");
    assert.equal(keptPath(dirs, "/elsewhere/a"), "/elsewhere/a");
    assert.equal(gitDirFor(dirs, root), root);
    assert.equal(gitDirFor(dirs, join(root, "wt/a")), "/ff");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("copyArtifacts copies a tree's artifacts/, leaving out the files over the limit and saying which", () => {
  const root = mkdtempSync(join(tmpdir(), "kept-test-"));
  try {
    mkdirSync(join(root, "wt/artifacts/sub"), { recursive: true });
    writeFileSync(join(root, "wt/artifacts/evidence.md"), "e");
    writeFileSync(join(root, "wt/artifacts/sub/profile.json"), "x".repeat(100));
    assert.deepEqual(copyArtifacts(join(root, "wt"), join(root, "item"), 10), { files: 1, skipped: ["sub/profile.json"] });
    assert.equal(readFileSync(join(root, "item/artifacts/evidence.md"), "utf8"), "e");
    assert.equal(readFileSync(join(root, "item/skipped.txt"), "utf8"), "sub/profile.json\n");
    assert.deepEqual(copyArtifacts(join(root, "none"), join(root, "item"), 10), { files: 0, skipped: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
