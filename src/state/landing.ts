// Whether a patch on Phabricator can land, as far as its own review goes: accepted by every active reviewer, and every
// comment either done there or addressed by its author (resubmitting carries the fix). Pure.
import type { InlineComment, PatchView, RequestState } from "../types.ts";

// A comment to answer: anyone's on the revision but its author's (you) and bots', reviewer or not. Before polls
// named the author: its reviewers' only.
export function isReviewComment(p: PatchView, c: InlineComment): boolean {
  // Bots, and Phabricator's own applications (Herald asking for a testing tag), which have no user name.
  if (/bot$/i.test(c.author) || c.author.startsWith("PHID-APPS-")) return false;
  return p.review?.author !== undefined ? c.author !== p.review.author : (p.review?.reviewers ?? []).some((r) => r.name === c.author);
}

// accepted: by its reviewers, and neither a backout's cause nor a fix for what try found still waiting for a green try run. landed: closed on
// Phabricator (a backout reopens it).
export function landingState(s: RequestState, p: PatchView): { accepted: boolean; commentsAddressed: boolean; landed: boolean } {
  const active = p.review?.reviewers.filter((r) => r.status !== "resigned") ?? [];
  const addressed = new Set(Object.values(s.jobs).filter((j) => j.purpose?.patch === p.id && j.exitCode === 0).flatMap((j) => j.purpose?.comments ?? []));
  return {
    // The revision's own status too: a reviewer's accept of an earlier diff stays in its list after an update.
    accepted: p.review?.status === "accepted" && active.length > 0 && active.every((r) => r.status === "accepted") && !(s.backouts[p.id]?.culprit && !s.backouts[p.id].verified) && !(s.tryNeeded?.[p.id] && !s.tryNeeded[p.id].verified),
    commentsAddressed: (p.review?.comments ?? []).filter((c) => isReviewComment(p, c)).every((c) => c.done || addressed.has(c.id)),
    landed: p.review?.status === "published",
  };
}

// Answered on Phabricator: a reply of yours on its line after it, the comment marked done there or the draft (if
// any) being one you posted.
export function isAnswered(p: PatchView, c: InlineComment): boolean {
  const bare = (t: string) => t.replace(/^\[[^\]\n]*\]\s*/, "").trim();
  const comments = p.review?.comments ?? [];
  const replies = comments.filter((x) => x.author === p.review?.author && x.id > c.id && x.file === c.file && x.line === c.line).map((x) => bare(x.text));
  const draft = p.replyDrafts.find((d) => d.commentId === c.id)?.text;
  return replies.length > 0 && (c.done || draft === undefined || replies.includes(bare(draft)));
}

// The draft replies still to post.
export function unpostedReplies(p: PatchView): number {
  return (p.review?.comments ?? []).filter((c) => c.author !== p.review?.author && p.replyDrafts.some((d) => d.commentId === c.id) && !isAnswered(p, c)).length;
}
