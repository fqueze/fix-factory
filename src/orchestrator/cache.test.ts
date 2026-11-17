import { test } from "node:test";
import assert from "node:assert/strict";
import type { JobView, RequestState } from "../types.ts";
import { expiredTasks } from "./cache.ts";

const DAY = 24 * 3_600_000;
const now = Date.parse("2026-11-30T00:00:00Z");
const ago = (days: number) => new Date(now - days * DAY).toISOString();
const fetching = (...tasks: string[]): Record<string, JobView> =>
  Object.fromEntries(tasks.map((t, i) => [`j${i}`, { purpose: { key: `artifacts:${t}:0`, what: "artifacts" } } as JobView]));
const req = (tasks: string[], s: Partial<RequestState>): Pick<RequestState, "jobs" | "step" | "updatedAt" | "finishedAt" | "splitInto"> => ({ jobs: fetching(...tasks), step: s.finishedAt ? "done" : "landing", updatedAt: ago(0), ...s });
const there = (...tasks: string[]) => tasks.map((task) => ({ task, madeAt: now - 40 * DAY }));

test("a request's cached logs go a day after it finished or split", () => {
  const reqs = [
    req(["done"], { finishedAt: ago(2), updatedAt: ago(2) }),
    req(["recent"], { finishedAt: ago(0.5), updatedAt: ago(0.5) }),
    req(["split"], { splitInto: ["r-x"], updatedAt: ago(1.5) }),
    req(["open"], { updatedAt: ago(1) }),
    req(["backout"], { finishedAt: ago(5), step: "landing" }),
  ];
  assert.deepEqual(expiredTasks(reqs, there("done", "recent", "split", "open", "backout"), now), ["done", "split"]);
});

test("those of a request without events for 28 days go too", () => {
  assert.deepEqual(expiredTasks([req(["idle"], { updatedAt: ago(29) }), req(["busy"], { updatedAt: ago(27) })], there("idle", "busy"), now), ["idle"]);
});

test("a task another request still needs stays", () => {
  assert.deepEqual(expiredTasks([req(["shared"], { finishedAt: ago(2) }), req(["shared"], {})], there("shared"), now), []);
});

test("a folder no request fetched goes 28 days after it was made", () => {
  assert.deepEqual(expiredTasks([], [{ task: "old", madeAt: now - 29 * DAY }, { task: "new", madeAt: now - 2 * DAY }], now), ["old"]);
});
