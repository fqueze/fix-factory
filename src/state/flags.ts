// Rules about ⚑s (needs-user entries) shared by the web server, which checks the commands you send, and the
// orchestrator, which executes them.
import type { ItemId, JobView, NeedsUser, RequestState } from "../types.ts";

// A user-done of these keys is your answer (approve-push: the approval, take-it: you took it, file-bug and
// meta-bug: the bug is filed...), so dismissing them would answer for you. A resubmit you decide against (the patch is
// landing as it is) can be dismissed.
const ANSWERED_BY_USER_DONE = ["approve-push", "take-it", "file-bug", "meta-bug", "submit", "land"];

export function canDismiss(key: string): boolean {
  return !ANSWERED_BY_USER_DONE.includes(key.split(":")[0]);
}

// Try pushes are never run again on their own, nor stopped: one may already have been made.
export function isPushJob(job: Pick<JobView, "name" | "purpose">): boolean {
  return job.purpose?.what === "push" || job.name === "try.ts push";
}

// The start of try.ts push's error when the stack's code changed since the dry run: nothing was pushed.
export const COMMITS_CHANGED = "not pushed: commits changed";

// You can retry any job but a push that may have been made: a refused one only while its push isn't made,
// declined, or being (or already) pushed by another job.
export function canRetry(r: RequestState, job: Pick<JobView, "job" | "name" | "purpose" | "error">): boolean {
  if (!isPushJob(job)) return true;
  if (job.error?.startsWith(COMMITS_CHANGED) !== true) return false;
  const id = job.purpose?.push;
  const push = id === undefined ? undefined : r.pushes[id];
  if (push?.rev !== undefined || push?.declined !== undefined) return false;
  return !Object.values(r.jobs).some((j) => j.job !== job.job && isPushJob(j) && j.purpose?.push === id && (j.endedAt === undefined || j.exitCode === 0));
}

// The ⚑ next() raises when the critical review still has must-fix findings after its round limit: a failed:<job>
// for a review that ran fine (a crashed review is a failed:<job> too, which Retry answers).
export function reviewLimitFlag(r: RequestState, item: ItemId): NeedsUser | undefined {
  return r.needsUser.find((n) => {
    const job = n.job === undefined ? undefined : r.jobs[n.job];
    return n.item === item && n.key.startsWith("failed:") && job?.name === "review-patch" && job.exitCode === 0;
  });
}
