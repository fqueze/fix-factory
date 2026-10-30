import { test } from "node:test";
import assert from "node:assert/strict";
import type { PatchView, RequestState } from "../types.ts";
import { isReviewComment, landingState } from "./landing.ts";

test("an accepted patch's comments count as addressed once its author's run handling them succeeded, before you resubmit", () => {
  const p = { id: "p", review: { status: "accepted", reviewers: [{ name: "smaug", status: "accepted" }], comments: [{ id: 1, author: "smaug", done: false }, { id: 2, author: "smaug", done: true }, { id: 3, author: "phab-bot", done: false }] } } as unknown as PatchView;
  const s = (exitCode: number) => ({ jobs: { j: { purpose: { patch: "p", comments: [1] }, exitCode } }, backouts: {}, bugLandings: {} }) as unknown as RequestState;
  assert.deepEqual(landingState(s(0), p), { accepted: true, commentsAddressed: true, landed: false });
  assert.equal(landingState(s(1), p).commentsAddressed, false, "a failed run addressed nothing");
});

test("Phabricator's own applications (Herald) aren't reviewers", () => {
  const p = { id: "p", review: { status: "accepted", author: "florian", reviewers: [], comments: [] } } as unknown as PatchView;
  assert.equal(isReviewComment(p, { id: 1, author: "PHID-APPS-PhabricatorHeraldApplication", text: "set a testing tag", done: false }), false);
  assert.equal(isReviewComment(p, { id: 2, author: "emilio", text: "why?", done: false }), true);
});
