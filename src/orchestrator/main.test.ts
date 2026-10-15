import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendCommand } from "../state/commands.ts";
import { appendEvent, readEvents, type EventInput } from "../state/events.ts";
import { groupMembers, readPidFile, startJob } from "../state/jobs.ts";
import type { Event, FactoryConfig } from "../types.ts";
import { Orchestrator, withDryRun } from "./main.ts";

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
      add(config.stateDir, { type: "request-created", request: "r-a", kind: "try-push", text: "", rev: "abc" });
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
      add(config.stateDir, { type: "request-created", request: "r-a", kind: "try-push", text: "", rev: "abc" });
      await o.startup();
      await o.tick();
      assert.equal(readEvents(config.stateDir, "r-a").filter((e) => e.type === "job-started").length, 0);
      appendCommand(config.stateDir, { cmd: "start-now", request: "r-a" });
      await o.tick();
      const events = readEvents(config.stateDir, "r-a");
      assert.deepEqual(events.filter((e) => e.type === "job-started").map((e) => (e as { name: string }).name), ["parse-request"]);
      assert.ok(events.some((e) => e.type === "command-executed" && e.ok));
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
      assert.deepEqual(started.map((e) => e.name), ["annotations.ts list"]);
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
});
