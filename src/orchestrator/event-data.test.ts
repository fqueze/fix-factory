import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { internalizeEvent, readEvents } from "../state/events.ts";
import { foldEvents } from "../state/fold.ts";
import { appendEventSafe } from "./event-data.ts";

test("an event over 4 KB keeps its envelope and moves its biggest values to data files", () => {
  const dir = mkdtempSync(join(tmpdir(), "event-data-"));
  try {
    const request = "r-1";
    appendEventSafe(dir, { type: "request-created", request, kind: "burndown", text: "small", folder: "a" });
    const comments = Array.from({ length: 60 }, (_, i) => ({ id: i, author: "smaug", text: `comment ${i} `.repeat(10), done: false }));
    appendEventSafe(dir, { type: "review-status", request, patch: "p", revision: 1, status: "needs-revision", reviewers: [{ name: "smaug", status: "blocking" }], comments });
    appendEventSafe(dir, { type: "stack", request, stack: "s", folder: "a", branch: "b", worktree: "/w", order: ["p"], summary: "x".repeat(10_000) });

    const raw = readFileSync(join(dir, "requests", request, "events.jsonl"), "utf8").trim().split("\n");
    assert.ok(raw.every((l) => Buffer.byteLength(l) < 4096));
    const line = JSON.parse(raw[1]) as { type: string; comments: unknown };
    assert.equal(line.type, "review-status");
    assert.match(JSON.stringify(line.comments), /^\{"dataFile":"requests\/r-1\/event-data\/[^"]+\.json"\}$/);
    assert.equal(readdirSync(join(dir, "requests", request, "event-data")).length, 2);

    // readEvents reads them back whole.
    const s = foldEvents(readEvents(dir, request));
    assert.equal(s.stacks.s.summary, "x".repeat(10_000));
    assert.equal(s.patches.p, undefined);
    assert.deepEqual((readEvents(dir, request)[1] as { comments: unknown }).comments, comments);
    // Look-alikes in a payload stay as they are.
    appendEventSafe(dir, { type: "agent-report", request, job: "j-1", prompt: "recover", report: { a: { dataFile: "x" }, b: { dataFile: "requests/r-2/event-data/y.json" } } });
    assert.deepEqual((readEvents(dir, request).at(-1) as { report: unknown }).report, { a: { dataFile: "x" }, b: { dataFile: "requests/r-2/event-data/y.json" } });
    assert.deepEqual(internalizeEvent(dir, request, { dataFile: "../../etc/passwd" }), { dataFile: "../../etc/passwd" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
