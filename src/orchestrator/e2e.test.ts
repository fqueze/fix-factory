// A try-push request driven through steps 1 → 4 → 5 and into 6 by the real loop: real detached
// jobs, a fake claude and fake CLIs answering from test/fixtures/orchestrator/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendCommand } from "../state/commands.ts";
import { listRequests, readEvents } from "../state/events.ts";
import { foldEvents } from "../state/fold.ts";
import type { Event, FactoryConfig } from "../types.ts";
import { Orchestrator } from "./main.ts";

const fixtures = fileURLToPath(new URL("../../test/fixtures/orchestrator/", import.meta.url));

export function setup(maxAgents = 3) {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-e2e-"));
  const config: FactoryConfig = {
    port: 0,
    stateDir: join(root, "state"),
    firefoxRepo: join(root, "firefox"),
    worktreesDir: join(root, "worktrees"),
    baseRef: "origin/main",
    claudeCommand: [process.execPath, join(fixtures, "fake-claude.js"), join(root, "claude.json")],
    stackViewerCommand: ["true"],
    profilerOrigin: "http://localhost:4242",
    maxAgents,
    maxBuilds: 1,
    dryRun: false,
  };
  mkdirSync(config.firefoxRepo, { recursive: true });
  mkdirSync(config.stateDir, { recursive: true });
  copyFileSync(join(fixtures, "e2e-claude.json"), join(root, "claude.json"));
  copyFileSync(join(fixtures, "e2e-cli.json"), join(root, "cli.json"));
  process.env.FAKE_WORKTREES = config.worktreesDir;
  const orchestrator = new Orchestrator({
    config,
    configPath: join(root, "factory.config.json"),
    codeVersion: "test",
    cliCommand: (tool) => [process.execPath, join(fixtures, "fake-cli.js"), join(root, "cli.json"), tool],
  });
  return { root, config, orchestrator };
}

export async function tickUntil(o: Orchestrator, done: () => boolean, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await o.tick();
    await new Promise((r) => setTimeout(r, 30));
  }
}

const calls = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);

test("a try-push request goes from the request to a planned verification push", async () => {
  const { root, config, orchestrator } = setup();
  try {
    await orchestrator.startup();
    appendCommand(config.stateDir, { cmd: "tell-factory", text: "Fix the dom/base failures of try push abcdef123456" });
    let events: Event[] = [];
    await tickUntil(orchestrator, () => {
      const [id] = listRequests(config.stateDir);
      events = id ? readEvents(config.stateDir, id) : [];
      return events.some((e) => e.type === "needs-user" && e.key.startsWith("approve-push:"));
    });
    const s = foldEvents(events);
    const of = <T extends Event["type"]>(type: T) => events.filter((e): e is Extract<Event, { type: T }> => e.type === type);

    // 1 → 3: routed as a try push with its config, then the initial push watched and the work list built from it.
    assert.match(s.id, /^r-\d{8}-fix-the-dom-base-failures$/);
    assert.deepEqual(of("request-routed").map((e) => [e.kind, e.rev]), [["try-push", "abcdef123456"]]);
    assert.deepEqual(of("config-set")[0].config, { folders: ["dom/base/test"], tests: [], platforms: [], constraints: [] });
    assert.deepEqual(
      of("step").map((e) => e.step),
      ["work list", "investigate and fix", "stack", "verify on try"],
    );
    assert.equal(s.pushes.initial.result, "failures");
    assert.deepEqual(of("try-job-failed").map((e) => e.taskId), ["TaskA"]);
    assert.deepEqual(Object.keys(s.items), ["i-test-a", "i-test-b"]);
    assert.equal(s.items["i-test-a"].group.ratePerWeek, 3);

    // 4: each item investigated in its own worktree, linted, reviewed.
    // maxBuilds is 1: the second worktree waited for the first.
    const states = (item: string) => of("item-state").filter((e) => e.item === item).map((e) => e.state);
    assert.deepEqual(states("i-test-a"), ["investigating", "fix verified locally", "in critical review", "reviewed", "in stack"]);
    // test_b's first review had findings: its author was resumed in the same session.
    assert.deepEqual(states("i-test-b"), ["waiting for a build slot", "investigating", "fix verified locally", "in critical review", "review findings", "fix verified locally", "in critical review", "reviewed", "in stack"]);
    const authorB = Object.values(s.jobs).filter((j) => j.name === "investigate-and-fix" && j.item === "i-test-b");
    assert.equal(authorB.length, 2);
    assert.equal(authorB[1].sessionId, authorB[0].sessionId);
    // Each run's cost: the session's total minus the earlier runs.
    assert.deepEqual(authorB.map((j) => j.costUsd), [0.25, 0.5]);
    const builds = of("job-started").filter((e) => e.kind === "build");
    const ends = new Map(of("job-finished").map((e) => [e.job, e.t]));
    assert.equal(builds.length, 3);
    assert.ok(builds.every((b, i) => i === 0 || b.t >= ends.get(builds[i - 1].job)!));
    assert.ok(of("needs-user").some((e) => e.key === "file-bug:p-test-a" && e.patch === "p-test-a"));
    assert.equal(s.patches["p-test-a"].bugDraft?.component, "DOM: Core & HTML");
    assert.equal(s.patches["p-test-b"].bug, 1234567);
    assert.ok(readFileSync(join(config.stateDir, "feedback", "fx-tests.md"), "utf8").includes("the failure list missed a config"));
    const investigate = Object.values(s.jobs).find((j) => j.name === "investigate-and-fix" && j.item === "i-test-a")!;
    assert.equal(investigate.costUsd, 1.5);
    assert.equal(investigate.model, "opus");
    assert.ok(existsSync(join(config.stateDir, "jobs", investigate.job, "prompt.md")));

    // 5: assembled, ordered (a rewrite, since the order changed), reviewed and summarized.
    const stack = s.stacks["dom-base-test"];
    assert.deepEqual(stack.order, ["p-test-b", "p-test-a"]);
    assert.match(stack.summary ?? "", /This stack fixes intermittent failures in dom\/base\/test/);
    assert.equal(s.patches["p-test-a"].sha, "f".repeat(40));
    assert.equal(s.patches["p-test-b"].sha, "e".repeat(40));
    assert.equal(s.patches["p-test-a"].worktree, stack.worktree);
    assert.equal(s.patches["p-test-a"].effort, 2);
    assert.ok(existsSync(join(config.stateDir, "requests", s.id, "data", "summary-dom-base-test.md")));

    // 6: the verification push is planned and waits for your approval.
    const planned = of("try-planned");
    assert.equal(planned.length, 1);
    assert.equal(planned[0].taskCount, 12);
    assert.deepEqual(
      s.needsUser.map((n) => n.key).sort(),
      ["approve-push:" + planned[0].push, "file-bug:p-test-a"].sort(),
    );

    // Every agent run got a prompt rendered from its template, on stdin, and nothing failed.
    const claude = calls(join(root, "claude.json.calls.jsonl"));
    assert.ok(claude.every((c) => !c.prompt.includes("{")));
    assert.ok(Object.values(s.jobs).every((j) => j.exitCode === 0 && j.error === undefined));
    assert.ok(Object.values(s.jobs).every((j) => j.endedAt !== undefined));
    const cli = calls(join(root, "cli.json.calls.jsonl"));
    assert.ok(cli.some((c) => c.argv[0] === "worktree.ts" && c.argv[1] === "create" && c.argv.includes("origin/main")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
