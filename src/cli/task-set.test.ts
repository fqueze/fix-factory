import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fakeTaskSet } from "../../test/fixtures/try/task-set.ts";
import { dryRunJobs, expandLabels, readJobs, taskSetPath } from "./task-set.ts";

describe("mach's cached task set", () => {
  it("is under the state dir of the srcdir, by name and sha256 of its real path, like get_state_dir", () => {
    const src = realpathSync(mkdtempSync(join(tmpdir(), "ff-src-")));
    const hash = createHash("sha256").update(src).digest("hex").slice(0, 12);
    assert.equal(taskSetPath(src, false, "/state"), `/state/srcdirs/${basename(src)}-${hash}/cache/taskgraph/target_task_set`);
    assert.equal(basename(taskSetPath(src, true, "/state")), "full_task_set");
  });

  it("expands chunk patterns like gecko: numbered chunks, the unchunked label, only chunk 1 with test paths", () => {
    const labels = ["t/opt-x-1", "t/opt-x-2", "t/opt-x-2-cf", "t/opt-x-nofis-1", "t/opt-y", "t/opt-z-3"];
    assert.deepEqual(expandLabels(["t/opt-x-*", "t/opt-y-*", "t/opt-z-3"], labels), ["t/opt-z-3", "t/opt-x-1", "t/opt-x-2", "t/opt-y"]);
    assert.deepEqual(expandLabels(["t/opt-x-*", "t/opt-z-3"], labels, { MOZHARNESS_TEST_PATHS: "{}" }), ["t/opt-z-3", "t/opt-x-1"]);
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
    assert.equal(dryRunJobs(wt, ["fuzzy"], config, state), undefined);
    const full = taskSetPath(wt, true, state);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, fakeTaskSet());
    assert.equal(dryRunJobs(wt, ["fuzzy"], config, state), undefined);
    assert.deepEqual(dryRunJobs(wt, ["fuzzy", "--full"], config, state)?.map((j) => j.label), ["test-linux2404-64/debug-xpcshell-1", "build-linux64/debug"]);
  });
});
