import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFeedback, renderFeedback } from "./feedback.ts";

test("feedback files parse into entries, rendered newest first with their request", () => {
  const entries = parseFeedback("## 2026-10-15T19:50:27.886Z — job j-1\n\nFirst **one**.\n\n## 2026-10-16T10:14:25.294Z — job j-2\n\nSecond\nline.\n");
  assert.deepEqual(entries, [
    { at: "2026-10-15T19:50:27.886Z", job: "j-1", text: "First **one**." },
    { at: "2026-10-16T10:14:25.294Z", job: "j-2", text: "Second\nline." },
  ]);
  const page = renderFeedback({ factory: entries.reverse(), inputs: [], "fx-tests": [], "profiler-cli": [], "searchfox-cli": [] }, []);
  assert.ok(page.indexOf("j-2") < page.indexOf("j-1"));
  assert.match(page, /<b>one<\/b>/);
  assert.match(page, /factory <b>2<\/b>/);
});

test("a session's point said again in its later reports shows once, in its newest wording", () => {
  const entries = parseFeedback(
    "## 2026-10-15T10:00:00.000Z — job j-1\n\nThe made no change notice pointed at the stack branch, but the patch had landed.\n\n" +
      "## 2026-10-15T11:00:00.000Z — job j-2\n\nThe made no change notice pointed at the stack branch, but this patch had already landed.\n\n" +
      "## 2026-10-15T12:00:00.000Z — job j-3\n\nSomething else entirely about profiles.\n",
  ).reverse();
  const r = { id: "r-1", text: "t", title: "t", jobs: { "j-1": { job: "j-1", name: "investigate-and-fix", sessionId: "s" }, "j-2": { job: "j-2", name: "investigate-and-fix", sessionId: "s" }, "j-3": { job: "j-3", name: "investigate-and-fix", sessionId: "s" } } } as unknown as Parameters<typeof renderFeedback>[1][number];
  const page = renderFeedback({ factory: entries, inputs: [], "fx-tests": [], "profiler-cli": [], "searchfox-cli": [] }, [r]);
  assert.match(page, /factory <b>2<\/b>/);
  assert.match(page, /this patch had already landed/);
  assert.doesNotMatch(page, /but the patch had landed/);
  assert.match(page, /in 2 of its reports/);
});
