import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitDirFor, keptPath } from "./kept.ts";

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
