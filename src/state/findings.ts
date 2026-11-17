// A patch's critical review findings, for its stack-viewer annotations and for what you answer to them there: those of
// the latest review of the patch (review-patch) and of the latest review of its stack (review-stack) that names it.
import type { JobId, JobView, PatchView, RequestState, ReviewPatchReport, ReviewStackReport } from "../types.ts";

export interface Finding {
  id: string; // f-<job>-<index in its report>
  job: JobId;
  of: "patch" | "stack"; // which review
  severity: "must-fix" | "nit";
  file?: string;
  line?: number;
  text: string;
  sha?: string; // the commit reviewed (its first 12 characters), when the review says
  t: string; // when the review ran
  addressed: boolean; // an author run took it up since
}

export function patchFindings(r: RequestState, p: PatchView, report: (job: JobId) => unknown): Finding[] {
  const jobs = Object.values(r.jobs);
  const ok = (j: JobView) => j.exitCode === 0 && j.endedAt !== undefined;
  const authorRuns = jobs.filter((j) => p.item !== undefined && j.item === p.item && j.purpose?.key.startsWith("author:"));
  const out: Finding[] = [];
  const review = jobs.findLast((j) => j.name === "review-patch" && j.purpose?.patch === p.id && ok(j));
  const patchReport = review && (report(review.job) as ReviewPatchReport | undefined);
  if (review && patchReport) {
    // As the request page's: any author run after the review took its findings up (the planner sends them).
    const addressed = authorRuns.some((j) => j.startedAt > review.startedAt);
    patchReport.findings.forEach((f, i) =>
      out.push({ id: `f-${review.job}-${i}`, job: review.job, of: "patch", severity: f.severity, ...(f.file ? { file: f.file } : {}), ...(f.line ? { line: f.line } : {}), text: f.text, ...(review.purpose?.sha ? { sha: review.purpose.sha } : {}), t: review.startedAt, addressed }),
    );
  }
  const stack = Object.values(r.stacks).find((s) => s.order.includes(p.id));
  const shas = r.patchShas[p.id] ?? [p.sha];
  const stackReview = stack && jobs.findLast((j) => j.name === "review-stack" && j.purpose?.stack === stack.id && ok(j));
  const stackReport = stackReview && (report(stackReview.job) as ReviewStackReport | undefined);
  if (stackReview && stackReport) {
    // Only its must-fix findings go to the authors, each in a run of its own.
    const addressed = authorRuns.some((j) => j.purpose!.key.endsWith(`:stack-review:${stackReview.job}`));
    stackReport.findings.forEach((f, i) => {
      const sha = shas.find((x) => x.startsWith(f.patch.slice(0, 12)));
      if (sha) out.push({ id: `f-${stackReview.job}-${i}`, job: stackReview.job, of: "stack", severity: f.severity, text: f.text, sha, t: stackReview.startedAt, addressed: addressed && f.severity === "must-fix" });
    });
  }
  return out;
}
