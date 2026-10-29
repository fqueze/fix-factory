import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, it, test } from "node:test";
import { codeFingerprint, watchTree } from "./supervise.ts";

describe("watchTree", () => {
  let base: string;
  let dir: string;
  let changes = 0;
  let close: () => void;
  // Waits for the events of the last step to settle, does the next one, and waits for its notification.
  async function sees(step: () => void): Promise<void> {
    await sleep(100);
    changes = 0;
    step();
    for (let i = 0; i < 200 && !changes; i++) await sleep(10);
    assert.ok(changes > 0, "no change notification");
  }

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "supervise-"));
    dir = join(base, "src");
    mkdirSync(join(dir, "a"), { recursive: true });
    writeFileSync(join(dir, "a", "x.ts"), "1");
    close = watchTree(
      dir,
      () => changes++,
      (e) => assert.fail(e),
    );
  });
  afterEach(() => {
    close();
    rmSync(base, { recursive: true });
  });

  it("sees each edit of a file replaced by a rename, in a subdirectory", async () => {
    // Written outside the tree, so only the rename-over is seen.
    for (const text of ["2", "3"]) {
      await sees(() => {
        writeFileSync(join(base, "tmp"), text);
        renameSync(join(base, "tmp"), join(dir, "a", "x.ts"));
      });
    }
  });

  it("watches new subdirectories", async () => {
    await sees(() => mkdirSync(join(dir, "b")));
    await sees(() => writeFileSync(join(dir, "b", "y.ts"), "1"));
  });
});

test("codeFingerprint: the same code, the same fingerprint; any change under src/, another", () => {
  const root = mkdtempSync(join(tmpdir(), "fp-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "package.json"), "{}\n");
  const first = codeFingerprint(root);
  assert.equal(codeFingerprint(root), first);
  writeFileSync(join(root, "src", "a.ts"), "export const a = 2;\n");
  assert.notEqual(codeFingerprint(root), first);
});
