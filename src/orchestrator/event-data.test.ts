import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvents } from "../state/events.ts";
import { foldEvents } from "../state/fold.ts";
import { appendEventSafe, internalizeEvent, readFullEvents } from "./event-data.ts";

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
    assert.equal(readEvents(dir, request)[0].type, "request-created");
    const review = readEvents(dir, request)[1] as unknown as { type: string; comments: unknown };
    assert.equal(review.type, "review-status");
    assert.match(JSON.stringify(review.comments), /^\{"dataFile":"requests\/r-1\/event-data\/[^"]+\.json"\}$/);
    assert.equal(readdirSync(join(dir, "requests", request, "event-data")).length, 2);

    const s = foldEvents(readFullEvents(dir, request));
    assert.equal(s.stacks.s.summary, "x".repeat(10_000));
    assert.throws(() => internalizeEvent(dir, { dataFile: "../../etc/passwd" }), /outside event-data/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
