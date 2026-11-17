// Your approval of a patch, shared by the page and the orchestrator: which patches wait for it before submitting.
import type { PatchView, ReviewStatus } from "../types.ts";

export type Fingerprint = (sha: string) => string | undefined;

// approved: the version you approved, or one with the same fingerprint (a rebase, a bug number put in its message);
// changed: you approved an earlier version.
export function reviewStatus(p: Pick<PatchView, "sha" | "approved">, fingerprint: Fingerprint | undefined): ReviewStatus {
  if (!p.approved) return "unreviewed";
  if (p.approved.sha === p.sha) return "approved";
  return fingerprint?.(p.sha) === p.approved.fingerprint ? "approved" : "changed";
}

export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = { approved: "Approved", changed: "Changed since approved", unreviewed: "Not approved yet" };

// What a moz-phab submit would send that you haven't approved: patches not landed, not as Phabricator has them already
// (the commit it has, or one with the same fingerprint: the stack rebased since).
export function unapproved(patches: PatchView[], fingerprint: Fingerprint | undefined): PatchView[] {
  const onPhabricator = (p: PatchView) =>
    p.revision !== undefined && [p.sentSha, p.review?.diff?.commit].some((sha) => sha !== undefined && (sha === p.sha || (fingerprint?.(sha) !== undefined && fingerprint(sha) === fingerprint(p.sha))));
  return patches.filter((p) => p.review?.status !== "published" && !onPhabricator(p) && reviewStatus(p, fingerprint) !== "approved");
}
