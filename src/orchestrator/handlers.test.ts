import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleWatchLines } from "./handlers.ts";
import { jsonLines } from "./runner.ts";
import { ID, Scenario } from "./testkit.ts";

const lines = [
  { type: "lando", landoJobId: 3, status: "landed" },
  { type: "pushed", rev: "abc", pushId: 1, url: "u" },
  { type: "job-failed", taskId: "T1", retryId: 0, jobId: 1, jobName: "test-linux/opt-xpcshell-2", platform: "linux", result: "testfailed", tier: 1 },
  { type: "progress", done: 3, total: 10, failures: 1 },
  { type: "progress", done: 3, total: 10, failures: 1 },
  { type: "finished", result: "failures", summary: "1 failed job", rev: "abc", done: 10, total: 10, failures: 1, notRun: [] },
];

describe("try.ts watch lines", () => {
  it("become try-pushed, try-job-failed, try-progress and try-finished, once each", () => {
    const sc = new Scenario("burndown", { folder: "a" });
    const events = handleWatchLines(sc.state(), sc.view(), "unskip", lines);
    assert.deepEqual(
      events.map((e) => e.type),
      ["try-pushed", "try-job-failed", "try-progress", "try-finished"],
    );
    for (const e of events) sc.add(e);
    const s = sc.state();
    assert.deepEqual(s.pushes.unskip.progress, { done: 3, total: 10, failures: 1 });
    assert.equal(s.pushes.unskip.result, "failures");
    // Read again from the start after a restart: nothing new.
    assert.deepEqual(handleWatchLines(sc.state(), sc.view(), "unskip", lines), []);
    assert.equal(sc.events.filter((e) => e.type === "try-job-failed" && e.request === ID).length, 1);
  });

  it("are read as they arrive: only complete lines", () => {
    const text = `${JSON.stringify(lines[1])}\n${JSON.stringify(lines[2])}\n{"type": "prog`;
    const first = jsonLines(text);
    assert.equal(first.lines.length, 2);
    const rest = jsonLines(`${text}ress", "done": 1, "total": 2, "failures": 0}\n`, first.next);
    assert.deepEqual(rest.lines, [{ type: "progress", done: 1, total: 2, failures: 0 }]);
  });
});
