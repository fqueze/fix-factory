import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pushIn } from "./no-push.ts";

test("finds a push anywhere in a command, and lets dry runs through", () => {
  for (const c of [
    "cd /wt; ./mach try fuzzy -q 'xpcshell --rebuild 15 --artifact",
    "git commit -qm WIP && ./mach try fuzzy -q x > artifacts/try.txt 2>&1",
    "./mach try auto",
    "git push origin HEAD",
    "hg push -r . try",
    "moz-phab submit; lando push",
    "./mach push-to-try",
  ]) {
    assert.ok(pushIn(c), c);
  }
  for (const c of ["./mach try fuzzy --no-push -q x", "./mach try fuzzy --help", "./mach test x --repeat 20", "git log --oneline", "fx-tests try abc --profiles"]) {
    assert.equal(pushIn(c), undefined, c);
  }
});

test("as a hook, blocks a push with exit code 2 and says why", () => {
  const run = (command: string) => spawnSync(process.execPath, [join(import.meta.dirname, "no-push.ts")], { input: JSON.stringify({ tool_input: { command } }), encoding: "utf8" });
  const blocked = run("./mach try fuzzy -q x");
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /agents never push/);
  assert.equal(run("./mach try fuzzy --no-push -q x").status, 0);
});

test("lets through one push you allowed its session, then blocks again", () => {
  const state = mkdtempSync(join(tmpdir(), "ff-no-push-"));
  mkdirSync(join(state, "allow-push"));
  writeFileSync(join(state, "allow-push", "s-1"), "now\n");
  const run = (session: string) =>
    spawnSync(process.execPath, [join(import.meta.dirname, "no-push.ts"), state], { input: JSON.stringify({ session_id: session, tool_input: { command: "./mach try fuzzy -q x" } }), encoding: "utf8" }).status;
  assert.equal(run("s-2"), 2, "another session's allowance");
  assert.equal(run("s-1"), 0);
  assert.equal(run("s-1"), 2, "only one");
});
