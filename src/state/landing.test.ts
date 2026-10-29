import { test } from "node:test";
import assert from "node:assert/strict";
import type { PatchView, RequestState } from "../types.ts";
import { landingState } from "./landing.ts";

test("an accepted patch's comments count as addressed once its author's run handling them succeeded, before you resubmit", () => {
  const p = { id: "p", review: { status: "accepted", reviewers: [{ name: "smaug", status: "accepted" }], comments: [{ id: 1, done: false }, { id: 2, done: true }] } } as unknown as PatchView;
  const s = (exitCode: number) => ({ jobs: { j: { purpose: { patch: "p", comments: [1] }, exitCode } } }) as unknown as RequestState;
  assert.deepEqual(landingState(s(0), p), { accepted: true, commentsAddressed: true, landed: false });
  assert.equal(landingState(s(1), p).commentsAddressed, false, "a failed run addressed nothing");
});
