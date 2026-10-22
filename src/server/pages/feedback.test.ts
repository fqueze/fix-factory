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
