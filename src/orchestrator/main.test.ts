import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendCommand } from "../state/commands.ts";
import { appendEvent, listRequests, readEvents, type EventInput } from "../state/events.ts";
import { foldEvents } from "../state/fold.ts";
import { groupMembers, jobDir, readPidFile, startJob } from "../state/jobs.ts";
import type { Event, FactoryConfig } from "../types.ts";
import { Orchestrator, withDryRun, worktreeLock } from "./main.ts";
import { ANNOTATIONS_ITEM, CANCELLED } from "./next.ts";
import { sessionIdFor } from "./plan.ts";

const fixtures = fileURLToPath(new URL("../../test/fixtures/orchestrator/", import.meta.url));

function setup(overrides: Partial<FactoryConfig> = {}, now = () => Date.now()) {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-main-"));
  const config: FactoryConfig = {
    port: 0,
    stateDir: join(root, "state"),
    firefoxRepo: root,
    worktreesDir: join(root, "wt"),
    baseRef: "origin/main",
    // No rules: every agent fails, which these tests don't look at.
    claudeCommand: [process.execPath, join(fixtures, "fake-claude.js"), join(root, "claude.json")],
    stackViewerCommand: ["true"],
    profilerOrigin: "http://localhost:4242",
    maxAgents: 1,
    maxBuilds: 1,
    dryRun: false,
    ...overrides,
  };
  mkdirSync(config.stateDir, { recursive: true });
  writeFileSync(join(root, "claude.json"), "[]");
  writeFileSync(join(root, "cli.json"), "[]");
  const o = new Orchestrator({ config, configPath: join(root, "factory.config.json"), codeVersion: "test", now, cliCommand: (tool) => [process.execPath, join(fixtures, "fake-cli.js"), join(root, "cli.json"), tool] });
  return { root, config, o };
}

const add = (stateDir: string, e: EventInput) => appendEvent(stateDir, e);

describe("Orchestrator", () => {
  it("starts agents within maxAgents, review comments first", async () => {
    const { root, config, o } = setup();
    try {
      add(config.stateDir, { type: "request-created", request: "r-a", kind: "unrouted", text: "fix try push abc" });
      // r-b is in review, with a new comment from its reviewer.
      const b = "r-b";
      add(config.stateDir, { type: "request-created", request: b, kind: "try-push", text: "", rev: "def" });
      add(config.stateDir, { type: "item-created", request: b, item: "i-x", folder: "x", group: { message: "m", tests: ["x/t.js"], configs: [] } });
      add(config.stateDir, {
        type: "job-started", request: b, job: "j-old", item: "i-x", kind: "agent", name: "investigate-and-fix", pid: 1, pidStartTime: 1, cmd: [], cwd: root, codeVersion: "t", sessionId: "s",
        purpose: { key: "author:i-x:initial", what: "author", item: "i-x", reason: "initial" },
      } as EventInput);
      add(config.stateDir, { type: "job-finished", request: b, job: "j-old", exitCode: 0, durationMs: 1, error: "not needed here" });
      add(config.stateDir, { type: "item-state", request: b, item: "i-x", state: "waiting for review" });
      add(config.stateDir, { type: "patch", request: b, patch: "p-x", item: "i-x", sha: "a".repeat(40), worktree: root, title: "Bug 1 - x, r=me.", bug: 1, revision: 5 });
      add(config.stateDir, { type: "review-status", request: b, patch: "p-x", revision: 5, status: "needs-revision", reviewers: [{ name: "smaug", status: "blocking" }], comments: [{ id: 1, author: "smaug", text: "why?", done: false }] });
      add(config.stateDir, { type: "step", request: b, step: "review comments" });
      await o.startup();
      await o.tick();
      const started = (id: string) => readEvents(config.stateDir, id).filter((e): e is Extract<Event, { type: "job-started" }> => e.type === "job-started" && e.job !== "j-old");
      // Scripts aren't capped (this synthetic item also starts its prior-art lookup).
      assert.deepEqual(started("r-a"), []);
      assert.deepEqual(started(b).filter((e) => e.kind === "agent").map((e) => e.name), ["classify-review-comments"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("start-now starts a queued request's jobs regardless of the caps", async () => {
    const { root, config, o } = setup({ maxAgents: 0 });
    try {
      add(config.stateDir, { type: "request-created", request: "r-a", kind: "unrouted", text: "fix try push abc" });
      await o.startup();
      await o.tick();
      assert.equal(readEvents(config.stateDir, "r-a").filter((e) => e.type === "job-started").length, 0);
      appendCommand(config.stateDir, { cmd: "start-now", request: "r-a" });
      await o.tick();
      const events = readEvents(config.stateDir, "r-a");
      assert.deepEqual(events.filter((e) => e.type === "job-started").map((e) => (e as { name: string }).name), ["route-request"]);
      assert.ok(events.some((e) => e.type === "command-executed" && e.ok));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Text from the global box that route-request forwards to r-a, until recover starts on r-a.
  async function forwarded(o: Orchestrator, root: string, config: FactoryConfig) {
    writeFileSync(join(root, "claude.json"), JSON.stringify([{ match: "^You wrote this", report: { existing: "r-a", feedback: [] } }]));
    add(config.stateDir, { type: "request-created", request: "r-a", kind: "try-push", text: "Fix the xpcshell failures", rev: "abcdef123456" });
    await o.startup();
    const told = appendCommand(config.stateDir, { cmd: "tell-factory", text: "Lando was down, re-push" });
    await o.tick();
    const id = `r-${told.t.slice(0, 10).replace(/-/g, "")}-lando-was-down-re-push`;
    const recover = () => readEvents(config.stateDir, "r-a").filter((e): e is Extract<Event, { type: "job-started" }> => e.type === "job-started" && e.name === "recover");
    for (let i = 0; i < 200 && recover().length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      await o.tick();
    }
    const unrouted = () => listRequests(config.stateDir).filter((r) => r !== "r-a");
    return { told, id, recover, unrouted };
  }

  it("makes a request of the global box's text, and forwards it to recover on the request route-request names", async () => {
    const { root, config, o } = setup({ maxAgents: 2 });
    try {
      const { told, id, recover } = await forwarded(o, root, config);
      const events = readEvents(config.stateDir, id);
      assert.deepEqual(events[0], { v: 1, t: told.t, type: "request-created", request: id, kind: "unrouted", text: "Lando was down, re-push", command: told.id });
      assert.equal(readFileSync(join(config.stateDir, "requests", id, "data", "requests.txt"), "utf8"), "r-a  Fix the failures of try push abcdef123456 (step: work list): Fix the xpcshell failures\n");
      assert.equal(recover()[0].purpose?.reason, "Lando was down, re-push");
      const s = foldEvents(events);
      assert.deepEqual([s.forwardedTo, s.step], ["r-a", "done"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps text it couldn't route open with its ⚑, until the next text from the main box supersedes it", async () => {
    const { config, o, root } = setup();
    try {
      add(config.stateDir, { type: "request-created", request: "r-hmm", kind: "unrouted", text: "hmm" });
      add(config.stateDir, { type: "needs-user", request: "r-hmm", key: "failed:j-1", action: "The factory couldn't tell what this is: rephrase it in the main box", detail: "d", job: "j-1" });
      // Another request with a ⚑ that isn't about routing stays as it is.
      add(config.stateDir, { type: "request-created", request: "r-b", kind: "try-push", text: "", rev: "abcdef123456" });
      add(config.stateDir, { type: "needs-user", request: "r-b", key: "failed:j-2", action: "x failed twice", detail: "d", job: "j-2" });
      await o.startup();
      const told = appendCommand(config.stateDir, { cmd: "tell-factory", text: "burn down dom/base/test" });
      await o.tick();
      const id = `r-${told.t.slice(0, 10).replace(/-/g, "")}-burn-down-dom-base-test`;
      const s = foldEvents(readEvents(config.stateDir, "r-hmm"));
      assert.deepEqual([s.step, s.supersededBy, s.needsUser, s.notes.map((n) => n.text)], ["done", id, [], [`Superseded by ${id}.`]]);
      assert.equal(foldEvents(readEvents(config.stateDir, "r-b")).needsUser.length, 1);
      assert.equal(foldEvents(readEvents(config.stateDir, id)).kind, "unrouted");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("executes the global box's text once when its commands are read again", async () => {
    const { root, config, o } = setup({ maxAgents: 2 });
    try {
      const { recover, unrouted } = await forwarded(o, root, config);
      rmSync(join(config.stateDir, "commands.cursor.json"));
      await o.tick();
      await o.tick();
      assert.equal(unrouted().length, 1);
      assert.equal(recover().length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("forwards once when route-request's job-finished was lost and the job is recorded again", async () => {
    const { root, config, o } = setup({ maxAgents: 2 });
    try {
      const { id, recover, unrouted } = await forwarded(o, root, config);
      // As if the orchestrator died after the forward, before job-finished.
      const path = join(config.stateDir, "requests", id, "events.jsonl");
      const lines = readFileSync(path, "utf8").trimEnd().split("\n");
      writeFileSync(path, lines.filter((l) => JSON.parse(l).type !== "job-finished").join("\n") + "\n");
      await o.tick();
      await o.tick();
      assert.ok(readEvents(config.stateDir, id).some((e) => e.type === "job-finished"));
      assert.equal(readFileSync(join(config.stateDir, "commands.jsonl"), "utf8").match(/"forward-/g)?.length, 2);
      assert.equal(unrouted().length, 1);
      assert.equal(recover().length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("at startup, counts a lost job as a failure and cancels an orphaned one", async () => {
    const { root, config, o } = setup({ maxAgents: 0, maxBuilds: 0 });
    try {
      add(config.stateDir, { type: "request-created", request: "r-a", kind: "burndown", text: "", folder: "a" });
      const purpose = (key: string) => ({ key, what: "unknown" });
      add(config.stateDir, { type: "job-started", request: "r-a", job: "j-lost", kind: "script", name: "x", pid: 2 ** 22 + 7, pidStartTime: 1, cmd: [], cwd: root, codeVersion: "t", purpose: purpose("k1") } as EventInput);
      // The wrapper dies, its command lives on: orphaned.
      const job = startJob(config.stateDir, { cmd: ["sleep", "30"], cwd: root, kind: "script", name: "sleep" }, { job: "j-orphan" });
      add(config.stateDir, { type: "job-started", request: "r-a", job: job.job, kind: "script", name: "sleep", pid: job.pid, pidStartTime: job.pidStartTime, cmd: ["sleep", "30"], cwd: root, codeVersion: "t", purpose: purpose("k2") } as EventInput);
      while (groupMembers(job.pid, job.pidStartTime).length < 2) await new Promise((r) => setTimeout(r, 20));
      process.kill(job.pid, "SIGKILL");
      while (groupMembers(job.pid, job.pidStartTime).length !== 1) await new Promise((r) => setTimeout(r, 20));
      await o.startup();
      const finished = readEvents(config.stateDir, "r-a").filter((e): e is Extract<Event, { type: "job-finished" }> => e.type === "job-finished");
      assert.deepEqual(finished.map((e) => [e.job, e.error]), [
        ["j-lost", "lost: no process and no exit.json"],
        ["j-orphan", "orphaned at restart: cancelled, the step starts again"],
      ]);
      const p = readPidFile(config.stateDir, "j-orphan")!;
      assert.deepEqual(groupMembers(p.pid, p.pidStartTime), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("shows a request it can't plan on its page, once per error, and goes on with the others", async () => {
    const { root, config, o } = setup();
    try {
      // annotations.ts "succeeded" with no output: next() can't parse it.
      add(config.stateDir, { type: "request-created", request: "r-a", kind: "burndown", text: "", folder: "a" });
      add(config.stateDir, { type: "step", request: "r-a", step: "first signal" });
      add(config.stateDir, { type: "job-started", request: "r-a", job: "j-wt", kind: "script", name: "worktree.ts create", pid: 1, pidStartTime: 1, cmd: [], cwd: root, codeVersion: "t", purpose: { key: "wt:signal", what: "worktree" } });
      mkdirSync(jobDir(config.stateDir, "j-wt"), { recursive: true });
      writeFileSync(join(jobDir(config.stateDir, "j-wt"), "out.log"), JSON.stringify({ path: root, branch: "b" }));
      add(config.stateDir, { type: "job-finished", request: "r-a", job: "j-wt", exitCode: 0, durationMs: 1 });
      add(config.stateDir, { type: "job-started", request: "r-a", job: "j-ann", kind: "script", name: "annotations.ts list", pid: 1, pidStartTime: 1, cmd: [], cwd: root, codeVersion: "t", purpose: { key: "annotations", what: "annotations" } });
      add(config.stateDir, { type: "job-finished", request: "r-a", job: "j-ann", exitCode: 0, durationMs: 1 });
      add(config.stateDir, { type: "request-created", request: "r-b", kind: "try-push", text: "", rev: "abc" });
      await o.startup();
      await o.tick();
      await o.tick();
      const a = readEvents(config.stateDir, "r-a");
      const flags = a.filter((e): e is Extract<Event, { type: "needs-user" }> => e.type === "needs-user");
      assert.equal(flags.length, 1);
      assert.match(flags[0].key, /^failed:plan:/);
      assert.match(flags[0].detail, /JSON/);
      assert.equal(a.filter((e) => e.type === "note").length, 1);
      assert.ok(readEvents(config.stateDir, "r-b").some((e) => e.type === "job-started"));
      // Once it plans again (here: the output became readable), its ⚑ goes.
      mkdirSync(jobDir(config.stateDir, "j-ann"), { recursive: true });
      writeFileSync(join(jobDir(config.stateDir, "j-ann"), "out.log"), "[]");
      await o.tick();
      assert.ok(readEvents(config.stateDir, "r-a").some((e) => e.type === "user-done" && e.key === flags[0].key));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records a command that fails as failed and goes on with the next one", async () => {
    const { root, config, o } = setup({ maxAgents: 0 });
    try {
      add(config.stateDir, { type: "request-created", request: "r-a", kind: "try-push", text: "", rev: "abc" });
      await o.startup();
      const bad = appendCommand(config.stateDir, { cmd: "set-bug", request: "r-a", patch: "p-nope", bug: 1 });
      const good = appendCommand(config.stateDir, { cmd: "approve-push", request: "r-a", push: "A" });
      await o.tick();
      const executed = readEvents(config.stateDir, "r-a").filter((e): e is Extract<Event, { type: "command-executed" }> => e.type === "command-executed");
      assert.deepEqual(executed.map((e) => [e.command, e.ok]), [[bad.id, false], [good.id, true]]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is present for 30 min after a visible page's last presence command", async () => {
    let now = Date.parse("2026-10-15T10:00:00Z");
    const { root, config, o } = setup({}, () => now);
    try {
      const at = (iso: string, visible = true) => appendCommand(config.stateDir, { cmd: "presence", visible, t: iso });
      at("2026-10-15T08:00:00.000Z");
      at("2026-10-15T09:40:00.000Z");
      at("2026-10-15T09:55:00.000Z");
      await o.startup();
      assert.deepEqual(o.presence(), { present: true, since: Date.parse("2026-10-15T09:40:00Z") });
      now = Date.parse("2026-10-15T10:26:00Z");
      assert.deepEqual(o.presence(), { present: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("in dry-run mode, starts no agent and passes --dry-run to the CLIs", async () => {
    const { root, config, o } = setup({ dryRun: true });
    try {
      add(config.stateDir, { type: "request-created", request: "r-a", kind: "burndown", text: "", folder: "a" });
      add(config.stateDir, { type: "step", request: "r-a", step: "first signal" });
      await o.startup();
      await o.tick();
      const events = readEvents(config.stateDir, "r-a");
      const started = events.filter((e): e is Extract<Event, { type: "job-started" }> => e.type === "job-started");
      assert.deepEqual(started.map((e) => e.name), ["worktree.ts create"]);
      assert.equal(started[0].cmd.at(-1), "--dry-run");
      // A raw command can't be given --dry-run: refused.
      appendCommand(config.stateDir, { cmd: "shell", request: "r-a", cwd: root, command: "touch pushed", reason: "r" });
      await o.tick();
      await o.tick();
      const after = readEvents(config.stateDir, "r-a");
      assert.equal(after.filter((e) => e.type === "job-started").length, 1);
      assert.equal(after.filter((e) => e.type === "note" && e.text.startsWith("Dry run: shell not started")).length, 1);
      const plan = (tool: string, args: string[]) => ({ purpose: { key: "k", what: "w" }, kind: "script" as const, name: "n", cwd: "/", cli: { tool, args } });
      assert.deepEqual(withDryRun(plan("try.ts", ["push", "--cwd", "/w", "--", "fuzzy", "-q", "x"])).cli?.args, ["push", "--cwd", "/w", "--dry-run", "--", "fuzzy", "-q", "x"]);
      assert.deepEqual(withDryRun(plan("lint-text.ts", ["--kind", "commit", "f"])).cli?.args, ["--kind", "commit", "f"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retrying a stopped author resumes its session, and doesn't also start it fresh", async () => {
    const { root, config, o } = setup();
    try {
      add(config.stateDir, { type: "request-created", request: "r-a", kind: "burndown", text: "", folder: "a" });
      add(config.stateDir, { type: "step", request: "r-a", step: "work list" });
      add(config.stateDir, { type: "job-started", request: "r-a", job: "j-wt", kind: "script", name: "worktree.ts create", pid: 1, pidStartTime: 1, cmd: [], cwd: root, codeVersion: "t", purpose: { key: "wt:signal", what: "worktree" } });
      mkdirSync(jobDir(config.stateDir, "j-wt"), { recursive: true });
      writeFileSync(join(jobDir(config.stateDir, "j-wt"), "out.log"), JSON.stringify({ path: root, branch: "b" }));
      add(config.stateDir, { type: "job-finished", request: "r-a", job: "j-wt", exitCode: 0, durationMs: 1 });
      const item = ANNOTATIONS_ITEM;
      const key = `author:${item}:initial`;
      const session = sessionIdFor("r-a", key);
      add(config.stateDir, { type: "item-created", request: "r-a", item, folder: "a", group: { message: "m", tests: [], configs: [] } });
      const purpose = { key, what: "author", item, reason: "initial" };
      add(config.stateDir, { type: "job-started", request: "r-a", job: "j-author", item, kind: "agent", name: "write-annotation-patches", pid: 1, pidStartTime: 1, cmd: [], cwd: root, codeVersion: "t", sessionId: session, purpose } as EventInput);
      const plan = { purpose, kind: "agent", name: "write-annotation-patches", item, cwd: root, agent: { sessionId: session, resume: false, vars: { folder: "a", annotations: "x" } } };
      mkdirSync(jobDir(config.stateDir, "j-author"), { recursive: true });
      writeFileSync(join(jobDir(config.stateDir, "j-author"), "plan.json"), JSON.stringify(plan));
      add(config.stateDir, { type: "job-finished", request: "r-a", job: "j-author", exitCode: -1, durationMs: 1, error: CANCELLED });
      add(config.stateDir, { type: "item-state", request: "r-a", item, state: "blocked", detail: "stopped" });
      add(config.stateDir, { type: "needs-user", request: "r-a", key: "stopped:j-author", action: "stopped", detail: "d", job: "j-author", item });
      await o.startup();
      appendCommand(config.stateDir, { cmd: "retry", request: "r-a", job: "j-author" });
      await o.tick();
      const started = readEvents(config.stateDir, "r-a").filter((e): e is Extract<Event, { type: "job-started" }> => e.type === "job-started" && e.job !== "j-author" && e.purpose?.key === key);
      assert.equal(started.length, 1);
      assert.equal(started[0].cmd[started[0].cmd.indexOf("--resume") + 1], session);
      assert.ok(!started[0].cmd.includes("--session-id"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("starts one job at a time in a worktree; agents and other directories don't wait", () => {
    const config = { worktreesDir: "/wt" } as FactoryConfig;
    const push = { kind: "script" as const, cwd: "/wt/stack-a" };
    const rewrite = { kind: "script" as const, cwd: "/wt/stack-a" };
    // Two starts in the same tick: the first starts, the second waits.
    const tick1 = worktreeLock(config, []);
    assert.equal(tick1(push), true);
    assert.equal(tick1(rewrite), false);
    assert.equal(tick1({ kind: "build", cwd: "/wt/stack-b" }), true);
    assert.equal(tick1({ kind: "agent", cwd: "/wt/stack-a" }), true);
    assert.equal(tick1({ kind: "build", cwd: "/repo" }), true);
    // While the push runs, it still waits; once it's finished, it starts.
    assert.equal(worktreeLock(config, [push])(rewrite), false);
    assert.equal(worktreeLock(config, [{ kind: "agent", cwd: "/wt/stack-a" }])(rewrite), true);
    assert.equal(worktreeLock(config, [])(rewrite), true);
  });
});
