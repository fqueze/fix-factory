import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execOk } from "../lib/exec.ts";
import { create, isInside, mentionsPath, mozconfig, processesUnder, remove, validateName, worktreeAddArgs } from "./worktree.ts";

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

test("remove kills only the worktree's processes, removes the tree, keeps the branch and outside objdirs", async () => {
  const { root, repo, git } = await tempRepo();
  const worktreesDir = join(root, "wt");
  const dest = join(worktreesDir, "a");
  const sharedObjdir = join(root, "shared-obj");
  await git("worktree", "add", "-q", "-b", "a", dest, "main");
  mkdirSync(sharedObjdir);
  writeFileSync(join(dest, "mozconfig"), `mk_add_options MOZ_OBJDIR=${sharedObjdir}\n`);
  mkdirSync(join(dest, "obj-dbg-artifact"));
  const spawnSleep = (marker: string, cwd = root) =>
    spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", marker], { stdio: "ignore", cwd });
  const byPath = spawnSleep(join(dest, "obj-dbg-artifact/dist/bin/firefox"));
  const byCwd = spawnSleep("./mach", join(dest, "obj-dbg-artifact"));
  const sibling = spawnSleep(dest + "-2/mach");
  const exited = (p: ReturnType<typeof spawn>) =>
    p.exitCode !== null || p.signalCode !== null ? Promise.resolve() : new Promise((r) => p.on("exit", r));
  try {
    const out = await remove("a", { repo, worktreesDir });
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
  } finally {
    for (const p of [sibling, byPath, byCwd]) p.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});
