import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fakeTaskSet } from "../../test/fixtures/try/task-set.ts";
import type { ExecResult } from "../lib/exec.ts";
import { decisionParameters, dryRunJobs, expandLabels, graphJobs, readJobs, readKinds, taskgraphJobs, taskSetPath, type TaskGraph } from "./task-set.ts";

// `mach taskgraph target-graph --json` for a mochitest-plain push with test paths, trimmed: two targets restricted to
// one chunk, one to two chunks, their builds, a docker image every try push targets, a toolchain they need.
const GRAPH = readFileSync(new URL("../../test/fixtures/try/taskgraph-target-graph.json", import.meta.url), "utf8");

describe("mach's cached task set", () => {
  it("is under the state dir of the srcdir, by name and sha256 of its real path, like get_state_dir", () => {
    const src = realpathSync(mkdtempSync(join(tmpdir(), "ff-src-")));
    const hash = createHash("sha256").update(src).digest("hex").slice(0, 12);
    assert.equal(taskSetPath(src, false, "/state"), `/state/srcdirs/${basename(src)}-${hash}/cache/taskgraph/target_task_set`);
    assert.equal(basename(taskSetPath(src, true, "/state")), "full_task_set");
  });

  it("expands chunk patterns like gecko: numbered chunks, or the unchunked label", () => {
    const labels = ["t/opt-x-1", "t/opt-x-2", "t/opt-x-2-cf", "t/opt-x-nofis-1", "t/opt-y", "t/opt-z-3"];
    assert.deepEqual(expandLabels(["t/opt-x-*", "t/opt-y-*", "t/opt-z-3"], labels), ["t/opt-z-3", "t/opt-x-1", "t/opt-x-2", "t/opt-y"]);
  });

  it("gives the kinds of the selected labels", () => {
    const file = join(mkdtempSync(join(tmpdir(), "ff-ts-")), "target_task_set");
    writeFileSync(file, fakeTaskSet());
    assert.deepEqual(readKinds(file, ["test-linux2404-64/debug-xpcshell-*", "build-linux64/debug", "nope"]), ["build", "test"]);
  });

  it("reads the selected jobs and their builds, with Treeherder's platform, collection, group, symbol and tier", () => {
    const file = join(mkdtempSync(join(tmpdir(), "ff-ts-")), "target_task_set");
    writeFileSync(file, fakeTaskSet());
    assert.deepEqual(readJobs(file, ["test-linux2404-64/debug-xpcshell-*", "test-linux2404-64/debug-xpcshell-nofis-*", "test-linux2404-64-asan/opt-xpcshell-*"]), [
      { label: "test-linux2404-64/debug-xpcshell-1", platform: "linux2404-64", collection: "debug", group: "X", symbol: "X1", tier: 1, build: "build-linux64/debug" },
      { label: "build-linux64/debug", platform: "linux64", collection: "debug", group: "", symbol: "B", tier: 1, artifact: true },
      { label: "test-linux2404-64/debug-xpcshell-2", platform: "linux2404-64", collection: "debug", group: "X", symbol: "X2", tier: 1, build: "build-linux64/debug" },
      { label: "test-linux2404-64/debug-xpcshell-nofis-1", platform: "linux2404-64", collection: "debug", group: "X-nofis", symbol: "X1", tier: 2, build: "build-linux64/debug" },
      { label: "test-linux2404-64-asan/opt-xpcshell", platform: "linux2404-64-asan", collection: "opt", group: "X", symbol: "X", tier: 1, build: "build-linux64-asan/opt" },
      { label: "build-linux64-asan/opt", platform: "linux64", collection: "asan", group: "", symbol: "Bo", tier: 1 },
    ]);
  });

  it("gives the jobs of a dry run from the worktree's task set (the full one with --full), or nothing without one", () => {
    const state = mkdtempSync(join(tmpdir(), "ff-mozbuild-"));
    const wt = mkdtempSync(join(tmpdir(), "ff-wt-"));
    const config = { tasks: ["test-linux2404-64/debug-xpcshell-*"], env: { MOZHARNESS_TEST_PATHS: '{"xpcshell": ["dom"]}' } };
    const all = ["test-linux2404-64/debug-xpcshell-1", "build-linux64/debug", "test-linux2404-64/debug-xpcshell-2"];
    assert.equal(dryRunJobs(wt, ["fuzzy"], config, state), undefined);
    const full = taskSetPath(wt, true, state);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, fakeTaskSet());
    assert.equal(dryRunJobs(wt, ["fuzzy"], config, state), undefined);
    assert.deepEqual(dryRunJobs(wt, ["fuzzy", "--full"], config, state)?.map((j) => j.label), all, "every chunk, test paths or not");
  });
});

describe("the decision task's graph", () => {
  const selected = [
    "test-linux2404-64/debug-mochitest-plain-*",
    "test-linux2404-64/debug-mochitest-plain-gpu",
    "test-linux2404-64/debug-mochitest-plain-standalone-*",
    "test-linux2404-64-shippable/opt-mochitest-plain-headless-3",
  ];

  it("has the target tasks and their builds (as artifact builds already, under use-artifact-builds), not the docker images every push targets, and tells the labels it dropped", () => {
    const { jobs, dropped } = graphJobs(JSON.parse(GRAPH) as TaskGraph, selected);
    assert.deepEqual(jobs, [
      { label: "test-linux2404-64/debug-mochitest-plain", platform: "linux2404-64", collection: "debug", group: "M", symbol: "1", tier: 1, build: "build-linux64/debug" },
      { label: "build-linux64/debug", platform: "linux64", collection: "debug", group: "", symbol: "Ba", tier: 1 },
      { label: "test-linux2404-64/debug-mochitest-plain-standalone-1", platform: "linux2404-64", collection: "debug", group: "M-sa", symbol: "1", tier: 1, build: "build-linux64/debug" },
      { label: "test-linux2404-64/debug-mochitest-plain-standalone-2", platform: "linux2404-64", collection: "debug", group: "M-sa", symbol: "2", tier: 1, build: "build-linux64/debug" },
      jobs.find((j) => j.label === "test-linux2404-64-shippable/opt-mochitest-plain-headless"),
      { label: "build-linux64-shippable/opt", platform: "linux64-shippable", collection: "opt", group: "Bpgo", symbol: "Ba", tier: 1 },
    ]);
    assert.ok(jobs[4], "a chunk that no longer exists answered by the task's one chunk");
    assert.deepEqual(dropped, ["test-linux2404-64/debug-mochitest-plain-gpu"]);
  });

  it("gets the parameters of a try push: mach try's over the try project's", () => {
    const p = decisionParameters({ optimize_target_tasks: false, try_task_config: { tasks: ["a"] } }, ["dom/a.js"]);
    assert.deepEqual(p, {
      project: "try", level: "1", target_tasks_method: "try_tasks", enable_always_target: true, release_type: "nightly",
      files_changed: ["dom/a.js"], optimize_target_tasks: false, try_task_config: { tasks: ["a"] }, try_mode: "try_task_config",
    });
  });

  it("comes from mach taskgraph target-graph in the worktree, for the kinds of the selected labels", async () => {
    const state = mkdtempSync(join(tmpdir(), "ff-mozbuild-"));
    const wt = mkdtempSync(join(tmpdir(), "ff-wt-"));
    const file = taskSetPath(wt, false, state);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, fakeTaskSet());
    const calls: { cmd: string[]; params: unknown }[] = [];
    const exec = async (cmd: string[], opts: { cwd?: string } = {}): Promise<ExecResult> => {
      assert.equal(opts.cwd, wt);
      calls.push({ cmd, params: JSON.parse(readFileSync(cmd[cmd.indexOf("-p") + 1], "utf8")) });
      writeFileSync(cmd[cmd.indexOf("-o") + 1], GRAPH);
      return { code: 0, stdout: "", stderr: "" };
    };
    const parameters = { try_task_config: { tasks: ["test-linux2404-64/debug-xpcshell-*", ...selected] } };
    const r = await taskgraphJobs(wt, ["fuzzy"], parameters, ["dom/a.js"], { exec, stateDir: state });
    assert.equal(r.jobs.length, 6);
    assert.deepEqual(r.dropped, ["test-linux2404-64/debug-xpcshell-*", "test-linux2404-64/debug-mochitest-plain-gpu"]);
    const cmd = calls[0].cmd;
    assert.deepEqual(cmd.slice(0, 7), ["timeout", "--kill-after=30", "600", "./mach", "taskgraph", "target-graph", "-p"]);
    assert.deepEqual(cmd.slice(8, -3), ["-k", "test"]);
    assert.deepEqual(calls[0].params, decisionParameters(parameters, ["dom/a.js"]));

    const failing = async (): Promise<ExecResult> => ({ code: 1, stdout: "Traceback", stderr: "" });
    await assert.rejects(taskgraphJobs(wt, ["fuzzy"], parameters, [], { exec: failing, stateDir: state }), /exited with 1: Traceback/);
  });
});
