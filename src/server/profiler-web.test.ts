import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profilerFile } from "./profiler-web.ts";

test("the profiler's files, its routes as index.html, nothing outside the build", () => {
  const root = mkdtempSync(join(tmpdir(), "profiler-web-test-"));
  try {
    const build = join(root, "rev");
    mkdirSync(join(build, "locales"), { recursive: true });
    writeFileSync(join(build, "index.html"), "");
    writeFileSync(join(build, "locales", "en.ftl"), "");
    writeFileSync(join(root, "secret"), "");
    symlinkSync(build, join(root, "current"));
    const dir = join(root, "current");
    assert.equal(profilerFile(dir, "/locales/en.ftl"), join(build, "locales/en.ftl"));
    assert.equal(profilerFile(dir, "/from-url/http%3A%2F%2Fx/calltree/"), join(build, "index.html"));
    assert.equal(profilerFile(dir, "/../secret"), undefined);
    assert.equal(profilerFile(dir, "/%2e%2e/secret"), undefined);
    assert.equal(profilerFile(join(root, "missing"), "/"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
