import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execOk } from "../lib/exec.ts";
import { create, isInside, isWorktreeOn, mentionsPath, mozconfig, processesUnder, remove, validateName, worktreeAddArgs } from "./worktree.ts";

test("mozconfig per build kind", () => {
  assert.equal(
    mozconfig("artifact"),
    "mk_add_options AUTOCLOBBER=1\nmk_add_options MOZ_OBJDIR=@TOPSRCDIR@/obj-opt-artifact\nac_add_options --enable-artifact-builds\n",
  );
  assert.equal(
    mozconfig("debug"),
    "mk_add_options AUTOCLOBBER=1\nmk_add_options MOZ_OBJDIR=@TOPSRCDIR@/obj-dbg-artifact\nac_add_options --enable-debug\nac_add_options --enable-artifact-builds\n",
  );
  assert.equal(mozconfig("full"), "mk_add_options AUTOCLOBBER=1\nmk_add_options MOZ_OBJDIR=@TOPSRCDIR@/obj-dbg\nac_add_options --enable-debug\n");
});

test("names, paths and git worktree add arguments", () => {
  validateName("bug123-fix");
  for (const bad of ["", "a/b", "-f", ".."]) assert.throws(() => validateName(bad), bad);
  assert.ok(isInside("/build/firefox/wt", "/build/firefox"));
  assert.ok(!isInside("/build/firefox-worktrees/a", "/build/firefox"));
  assert.deepEqual(worktreeAddArgs("/wt/a", "a", "main", false), ["worktree", "add", "-b", "a", "/wt/a", "main"]);
  assert.deepEqual(worktreeAddArgs("/wt/a", "a", "a", true), ["worktree", "add", "/wt/a", "a"]);
});

test("isInside resolves symlinks", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "isinside-test-")));
  try {
    mkdirSync(join(root, "repo"));
    symlinkSync(join(root, "repo"), join(root, "link"));
    assert.ok(isInside(join(root, "link/wt"), join(root, "repo")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mentionsPath: the path or below it, not a sibling", () => {
  assert.ok(mentionsPath("/wt/a/obj/dist/bin/firefox -profile /tmp/x", "/wt/a"));
  assert.ok(mentionsPath("python3 /wt/a/mach build", "/wt/a"));
  assert.ok(mentionsPath("node x.ts --cwd=/wt/a", "/wt/a"));
  assert.ok(mentionsPath("ls /wt/a -l", "/wt/a"));
  for (const sibling of ["/wt/a-2/mach", "/wt/ab/mach", "/wt/a.old/mach", "/wt/a+x/mach"]) {
    assert.ok(!mentionsPath(`python3 ${sibling} build`, "/wt/a"), sibling);
  }
});

test("processesUnder reads /proc-style cmdlines and cwds", () => {
  const proc = mkdtempSync(join(tmpdir(), "proc-test-"));
  try {
    const add = (pid: string, args: string[], cwd?: string) => {
      mkdirSync(join(proc, pid));
      writeFileSync(join(proc, pid, "cmdline"), args.join("\0") + "\0");
      if (cwd) symlinkSync(cwd, join(proc, pid, "cwd"));
    };
    add("10", ["/wt/a/obj/dist/bin/firefox", "-marionette"]);
    add("11", ["python3", "/wt/a-2/mach", "build"], "/wt/a-2");
    add("12", ["bash"], "/home");
    add("13", ["node", "/wt/a/x.js"]);
    add("15", ["python3", "./mach", "test"], "/wt/a/sub");
    mkdirSync(join(proc, "self"));
    mkdirSync(join(proc, "14")); // exited: no cmdline
    assert.deepEqual(processesUnder("/wt/a", proc, 13), [
      { pid: 10, cmdline: "/wt/a/obj/dist/bin/firefox -marionette" },
      { pid: 15, cmdline: "python3 ./mach test" },
    ]);
  } finally {
    rmSync(proc, { recursive: true, force: true });
  }
});

async function tempRepo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "worktree-test-")));
  const repo = join(root, "firefox");
  mkdirSync(repo);
  const git = (...args: string[]) => execOk(["git", "-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { cwd: repo });
  await git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "mach"), "");
  await git("add", ".");
  await git("commit", "-qm", "init");
  return { root, repo, git };
}

test("create refuses a worktreesDir inside the checkout", async () => {
  const { root, repo } = await tempRepo();
  try {
    await assert.rejects(create("a", { build: "artifact", repo, worktreesDir: join(repo, "wt") }), /is inside/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("create can be run again after a failed build: it reuses the worktree and builds again", async () => {
  const { root, repo, git } = await tempRepo();
  const worktreesDir = join(root, "wt");
  // A mach that fails while FAKE_MACH_STATUS says so.
  writeFileSync(join(repo, "mach"), "#!/bin/sh\nexit ${FAKE_MACH_STATUS:-0}\n");
  chmodSync(join(repo, "mach"), 0o755);
  await git("commit", "-qam", "mach");
  try {
    process.env.FAKE_MACH_STATUS = "1";
    await assert.rejects(create("a", { build: "artifact", repo, worktreesDir, base: "main" }), /the build failed \(exit 1\); running create again/);
    process.env.FAKE_MACH_STATUS = "0";
    const out = await create("a", { build: "artifact", repo, worktreesDir, base: "main" });
    assert.equal(out.path, join(worktreesDir, "a"));
    assert.equal(out.branch, "a");
    mkdirSync(join(worktreesDir, "b"));
    await assert.rejects(create("b", { build: "artifact", repo, worktreesDir }), /isn't the worktree of branch b/);
  } finally {
    delete process.env.FAKE_MACH_STATUS;
    rmSync(root, { recursive: true, force: true });
  }
});

test("an item's worktree is a symlink to a slot, its build outside the tree; removed, its slot goes to the next item, reset to that item's branch", async () => {
  const { root, repo, git } = await tempRepo();
  const worktreesDir = join(root, "wt");
  const objdirsDir = join(root, "objdirs");
  writeFileSync(join(repo, "mach"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(repo, "mach"), 0o755);
  await git("commit", "-qam", "mach");
  const opts = { build: "artifact" as const, repo, worktreesDir, objdirsDir, base: "main" };
  try {
    const a = await create("a", opts);
    assert.equal(a.path, join(worktreesDir, "a"));
    assert.equal(realpathSync(a.path), join(worktreesDir, "slots", "opt-artifact-1"));
    assert.equal("objdir" in a && a.objdir, join(objdirsDir, "opt-artifact-1"));
    assert.match(readFileSync(join(a.path, "mozconfig"), "utf8"), new RegExp(`MOZ_OBJDIR=${objdirsDir}/opt-artifact-1\n`));
    writeFileSync(join(a.path, "fix.txt"), "a's fix\n");
    await execOk(["git", "-c", "user.name=T", "-c", "user.email=t@example.com", "add", "fix.txt"], { cwd: a.path });
    await execOk(["git", "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qm", "a's fix"], { cwd: a.path });
    writeFileSync(join(a.path, "scratch.log"), "untracked\n");
    const gone = await remove("a", { repo, worktreesDir, stateDir: join(root, "state") });
    assert.equal(gone.freed, "opt-artifact-1");
    assert.ok(!existsSync(a.path), "its symlink is gone");
    assert.ok(existsSync(join(worktreesDir, "slots", "opt-artifact-1")), "its slot stays");
    // The next item gets that slot, on its own branch, without a's files.
    const b = await create("b", { ...opts, base: "main" });
    assert.equal(realpathSync(b.path), join(worktreesDir, "slots", "opt-artifact-1"));
    assert.equal((await execOk(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: b.path })).trim(), "b");
    assert.ok(!existsSync(join(b.path, "fix.txt")) && !existsSync(join(b.path, "scratch.log")));
    // a comes back, on its branch, in a slot of its own: b holds the other.
    const back = await create("a", { build: "artifact", repo, worktreesDir, objdirsDir });
    assert.equal(realpathSync(back.path), join(worktreesDir, "slots", "opt-artifact-2"));
    assert.equal(readFileSync(join(back.path, "fix.txt"), "utf8"), "a's fix\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isWorktreeOn reads git worktree list --porcelain", () => {
  const out = "worktree /ff\nHEAD 1\nbranch refs/heads/main\n\nworktree /wt/a\nHEAD 2\nbranch refs/heads/a\n\nworktree /wt/c\nHEAD 3\ndetached\n";
  assert.ok(isWorktreeOn(out, "/wt/a", "a"));
  assert.ok(!isWorktreeOn(out, "/wt/a", "main"));
  assert.ok(!isWorktreeOn(out, "/wt/c", "c"));
});

test("remove kills only the worktree's processes, removes the tree, keeps the branch and outside objdirs", async () => {
  const { root, repo, git } = await tempRepo();
  const worktreesDir = join(root, "wt");
  const dest = join(worktreesDir, "a");
  const sharedObjdir = join(root, "shared-obj");
  await git("worktree", "add", "-q", "-b", "a", dest, "main");
  mkdirSync(sharedObjdir);
  writeFileSync(join(dest, "mozconfig"), `mk_add_options MOZ_OBJDIR=${sharedObjdir}\n`);
  mkdirSync(join(dest, "obj-dbg-artifact"));
  mkdirSync(join(dest, "artifacts/logs"), { recursive: true });
  writeFileSync(join(dest, "artifacts/evidence.md"), "why\n");
  writeFileSync(join(dest, "artifacts/logs/run.log"), "log\n");
  writeFileSync(join(dest, "f"), "1\n");
  await execOk(["git", "add", "f"], { cwd: dest });
  await execOk(["git", "commit", "-qm", "v1"], { cwd: dest });
  const v1 = (await execOk(["git", "rev-parse", "HEAD"], { cwd: dest })).trim();
  await execOk(["git", "commit", "-q", "--amend", "-m", "v2"], { cwd: dest });
  const stateDir = join(root, "state");
  const spawnSleep = (marker: string, cwd = root) =>
    spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", marker], { stdio: "ignore", cwd });
  const byPath = spawnSleep(join(dest, "obj-dbg-artifact/dist/bin/firefox"));
  const byCwd = spawnSleep("./mach", join(dest, "obj-dbg-artifact"));
  const sibling = spawnSleep(dest + "-2/mach");
  const exited = (p: ReturnType<typeof spawn>) =>
    p.exitCode !== null || p.signalCode !== null ? Promise.resolve() : new Promise((r) => p.on("exit", r));
  try {
    const out = await remove("a", { repo, worktreesDir, stateDir });
    assert.deepEqual(
      out.killed.map((p) => p.pid).sort(),
      [byPath.pid, byCwd.pid].sort(),
    );
    await exited(byPath);
    await exited(byCwd);
    assert.equal(sibling.exitCode, null);
    assert.ok(!existsSync(dest));
    assert.ok(existsSync(sharedObjdir));
    assert.equal((await git("branch", "--list", "a")).trim(), "a");
    assert.equal(readFileSync(join(stateDir, "kept/a/artifacts/evidence.md"), "utf8"), "why\n");
    assert.equal(readFileSync(join(stateDir, "kept/a/artifacts/logs/run.log"), "utf8"), "log\n");
    assert.match(await git("for-each-ref", "--format=%(refname)", "refs/fix-factory/a/"), new RegExp(`refs/fix-factory/a/${v1}`));
  } finally {
    for (const p of [sibling, byPath, byCwd]) p.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("create replaces the branch a failed worktree add left, but not one with commits of its own", async () => {
  const { root, repo, git } = await tempRepo();
  const worktreesDir = join(root, "wt");
  writeFileSync(join(repo, "mach"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(repo, "mach"), 0o755);
  await git("commit", "-qam", "mach");
  try {
    await git("branch", "a", "main");
    assert.equal((await create("a", { build: "artifact", repo, worktreesDir, base: "main" })).branch, "a");
    await git("checkout", "-qb", "c");
    await git("commit", "-q", "--allow-empty", "-m", "work");
    await git("checkout", "-q", "main");
    await assert.rejects(create("c", { build: "artifact", repo, worktreesDir, base: "main" }), /branch c already exists/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
