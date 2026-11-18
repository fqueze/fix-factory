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

export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = { approved: "Approved", changed: "Changed since you approved it", unreviewed: "Needs review" };
// What hovering the status says, in stack-viewer's list and on the badge.
export const REVIEW_STATUS_TOOLTIPS: Record<ReviewStatus, string> = {
  approved: "You approved it",
  changed: "Changed since you approved it: Approve this version is at the end of its page",
  unreviewed: "Needs your review: Approve is at the end of its page",
};

// What a moz-phab submit would send for the first time that you haven't approved. A patch already on Phabricator is
// resubmitted from its interdiff, which the page shows you: no approval in stack-viewer.
export function unapproved(patches: PatchView[], fingerprint: Fingerprint | undefined): PatchView[] {
  return patches.filter((p) => p.revision === undefined && reviewStatus(p, fingerprint) !== "approved");
}
