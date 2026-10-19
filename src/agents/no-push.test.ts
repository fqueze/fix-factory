import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pushIn, shellCommands } from "./no-push.ts";

test("splits a command line into shell words", () => {
  assert.deepEqual(shellCommands(`git commit -m "a; b" && echo 'c|d' x\\ y | cat $(git push) \`hg push\``), [
    ["git", "commit", "-m", "a; b"],
    ["echo", "c|d", "x y"],
    ["cat"],
    ["git", "push"],
    ["hg", "push"],
  ]);
  assert.deepEqual(shellCommands(`echo "x $(git push) \`hg push\`"`), [["git", "push"], ["hg", "push"], ["echo", "x $(git push) `hg push`"]]);
});

test("finds a push anywhere in a command, and lets dry runs through", () => {
  for (const c of [
    "cd /wt; ./mach try fuzzy -q 'xpcshell --rebuild 15 --artifact",
    "git commit -qm WIP && ./mach try fuzzy -q x > artifacts/try.txt 2>&1",
    "./mach try auto",
    "git push origin HEAD",
    "hg push -r . try",
    "lando push",
    "moz-phab submit",
    "./mach push-to-try",
    // Global options before the subcommand
    "git -C /wt push",
    "git -c x=1 push",
    "git --no-pager push",
    "git --git-dir=/wt/.git push",
    "git send-pack remote",
    "git -c alias.p=push p",
    "hg -R /wt push",
    "hg --cwd /wt push",
    "hg --config ui.x=1 push",
    "./mach --no-interactive try fuzzy -q x",
    "./mach -l log try fuzzy",
    "python3 mach try auto",
    "/src/firefox/mach try auto",
    "MOZ_X=1 timeout -k 5 600 ./mach try auto",
    "env -i git push",
    "if true; then git push; fi",
    // --no-push only counts as an argument of its own
    `./mach try fuzzy -q x -m "not --no-push"`,
    "./mach try fuzzy -q x --no-push-yet",
    "./mach try fuzzy -- --no-push",
    // Substitutions and shells
    "echo $(git push)",
    'echo "$(./mach try auto)"',
    "echo `hg push`",
    "eval git push",
    "eval 'git push'",
    `bash -c "git -C /wt push"`,
    "sh -ec './mach try auto'",
  ]) {
    assert.ok(pushIn(c), c);
  }
  for (const c of [
    "./mach try fuzzy --no-push -q x",
    "./mach try fuzzy --help",
    "./mach try -h",
    "./mach test x --repeat 20",
    "git log --oneline",
    "git commit -m 'git push later'",
    'git commit -m "./mach try auto"',
    "grep -r lando .",
    "fx-tests try abc --profiles",
    "git -C /wt log push",
  ]) {
    assert.equal(pushIn(c), undefined, c);
  }
});

test("tells try pushes from other pushes", () => {
  assert.equal(pushIn("./mach try auto")?.tryPush, true);
  assert.equal(pushIn("hg push -r . ssh://hg.mozilla.org/try")?.tryPush, true);
  assert.equal(pushIn("hg push -r . try")?.tryPush, true);
  assert.equal(pushIn("git push origin HEAD")?.tryPush, false);
  assert.equal(pushIn("lando push")?.tryPush, false);
});

const hook = (args: string[], input: string) => spawnSync(process.execPath, [join(import.meta.dirname, "no-push.ts"), ...args], { input, encoding: "utf8" });

test("as a hook, blocks a push with exit code 2 and says why", () => {
  const run = (command: string) => hook(["/nonexistent"], JSON.stringify({ tool_input: { command } }));
  const blocked = run("./mach try fuzzy -q x");
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /agents never push/);
  assert.equal(run("./mach try fuzzy --no-push -q x").status, 0);
});

test("as a hook, blocks whatever it can't check", () => {
  const crash = hook(["/nonexistent"], "not json");
  assert.equal(crash.status, 2);
  assert.match(crash.stderr, /no-push hook failed/);
  assert.equal(hook([], JSON.stringify({ tool_input: { command: "ls" } })).status, 2, "no state directory");
});

test("lets through one try push you allowed its session, then blocks again", () => {
  const state = mkdtempSync(join(tmpdir(), "ff-no-push-"));
  mkdirSync(join(state, "allow-push"));
  const allowance = join(state, "allow-push", "s-1");
  writeFileSync(allowance, "now\n");
  const run = (session: string, command = "./mach try fuzzy -q x") => hook([state], JSON.stringify({ session_id: session, tool_input: { command } })).status;
  assert.equal(run("s-2"), 2, "another session's allowance");
  assert.equal(run("s-1", "git push origin HEAD"), 2, "not for another push");
  assert.equal(run("s-1", "lando push"), 2, "not for Lando");
  assert.ok(existsSync(allowance), "still there");
  assert.equal(run("s-1"), 0);
  assert.equal(run("s-1"), 2, "only one");
});
