// Whether a patch on Phabricator can land, as far as its own review goes: accepted by every active reviewer, and every
// comment either done there or addressed by its author (resubmitting carries the fix). Pure.
import type { PatchView, RequestState } from "../types.ts";

export function landingState(s: RequestState, p: PatchView): { accepted: boolean; commentsAddressed: boolean; landed: boolean } {
  const active = p.review?.reviewers.filter((r) => r.status !== "resigned") ?? [];
  const reviewers = new Set(p.review?.reviewers.map((r) => r.name) ?? []);
  const addressed = new Set(Object.values(s.jobs).filter((j) => j.purpose?.patch === p.id && j.exitCode === 0).flatMap((j) => j.purpose?.comments ?? []));
  return {
    accepted: active.length > 0 && active.every((r) => r.status === "accepted"),
    // Its reviewers' comments: not bots', nor your replies.
    commentsAddressed: (p.review?.comments ?? []).filter((c) => reviewers.has(c.author)).every((c) => c.done || addressed.has(c.id)),
    landed: p.review?.status === "published",
  };
}
