import { test } from "node:test";
import assert from "node:assert/strict";
import type { PatchView, RequestState } from "../types.ts";
import { isReviewComment, landingState, unpostedReplies } from "./landing.ts";

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

test("a revision back in needs-review isn't accepted, though its reviewers' accepts of an earlier diff remain", () => {
  const p = { id: "p", review: { status: "needs-review", reviewers: [{ name: "#tabbrowser-reviewers", status: "accepted" }, { name: "sthompson", status: "accepted" }], comments: [] } } as unknown as PatchView;
  assert.equal(landingState({ jobs: {}, backouts: {} } as unknown as RequestState, p).accepted, false);
});

test("an accepted revision with a reviewer group still pending, not blocking, is accepted (D337713)", () => {
  const p = { id: "p", review: { status: "accepted", reviewers: [{ name: "#dom-core-reviewers", status: "accepted-prior" }, { name: "#layout-reviewers", status: "pending" }, { name: "smaug", status: "accepted-prior" }], comments: [] } } as unknown as PatchView;
  assert.equal(landingState({ jobs: {}, backouts: {} } as unknown as RequestState, p).accepted, true);
});

test("the draft replies to post leave out those already on Phabricator, whichever run wrote them", () => {
  const p = {
    id: "p",
    review: {
      status: "needs-revision",
      author: "florian",
      reviewers: [],
      comments: [
        { id: 1, author: "emilio", file: "a", line: 1, text: "why?", done: false },
        { id: 2, author: "emilio", file: "a", line: 2, text: "how?", done: false },
        { id: 3, author: "florian", file: "a", line: 2, text: "[Claude's reply]\nLike this.", done: false },
      ],
    },
    replyDrafts: [{ commentId: 1, text: "Because." }, { commentId: 2, text: "Like this." }],
  } as unknown as PatchView;
  assert.equal(unpostedReplies(p), 1);
});
