// Whether a patch on Phabricator can land, as far as its own review goes: accepted by every active reviewer, and every
// comment either done there or addressed by its author (resubmitting carries the fix). Pure.
import type { InlineComment, PatchView, RequestState } from "../types.ts";

// A comment to answer: anyone's on the revision but its author's (you) and bots', reviewer or not. Before polls
// named the author: its reviewers' only.
export function isReviewComment(p: PatchView, c: InlineComment): boolean {
  if (/bot$/i.test(c.author)) return false;
  return p.review?.author !== undefined ? c.author !== p.review.author : (p.review?.reviewers ?? []).some((r) => r.name === c.author);
}

export function landingState(s: RequestState, p: PatchView): { accepted: boolean; commentsAddressed: boolean; landed: boolean } {
  const active = p.review?.reviewers.filter((r) => r.status !== "resigned") ?? [];
  const addressed = new Set(Object.values(s.jobs).filter((j) => j.purpose?.patch === p.id && j.exitCode === 0).flatMap((j) => j.purpose?.comments ?? []));
  return {
    accepted: active.length > 0 && active.every((r) => r.status === "accepted"),
    commentsAddressed: (p.review?.comments ?? []).filter((c) => isReviewComment(p, c)).every((c) => c.done || addressed.has(c.id)),
    landed: p.review?.status === "published",
  };
}
