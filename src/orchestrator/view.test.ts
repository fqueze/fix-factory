import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Event } from "../types.ts";
import { buildView } from "./view.ts";

describe("buildView", () => {
  it("drops a start Claude Code refused because its session ran in another job", () => {
    const purpose = { key: "author:i-a:initial", what: "author", item: "i-a" };
    const start = (job: string, t: string) => ({ type: "job-started", request: "r", job, kind: "agent", name: "investigate-and-fix", item: "i-a", cwd: "/wt", sessionId: "s1", pid: 1, pidStartTime: 1, cmd: [], purpose, v: 1, t });
    const view = buildView([
      start("j-resumed", "2026-10-21T09:50:14.145Z"),
      start("j-fresh", "2026-10-21T09:50:14.194Z"),
      { type: "job-finished", request: "r", job: "j-fresh", exitCode: 0, durationMs: 1, error: "no result line (exit code 0): Error: Session ID s1 is already in use.", v: 1, t: "2026-10-21T09:50:18Z" },
    ] as unknown as Event[]);
    assert.deepEqual(view.byKey.get(purpose.key)!.map((j) => j.job), ["j-resumed"]);
    assert.deepEqual(view.jobs.map((j) => j.job), ["j-resumed"]);
  });
});
