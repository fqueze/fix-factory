// Reports of the prompts whose types aren't in src/types.ts yet (see the proposal in the
// orchestrator's report: they belong next to InvestigateReport). schemas/<prompt>.json must match.
import type { BugDraft, Dep, Feedback, InlineComment } from "../types.ts";

export interface ParseRequestReport {
  config: { folders: string[]; tests: string[]; platforms: string[]; constraints: string[] };
  questions: string[];
  feedback: Feedback[];
}

export interface ClassifyAnnotationReport {
  kind: "scoping" | "flakiness" | "unclear";
  reason: string;
  feedback: Feedback[];
}

export interface WriteAnnotationPatchesReport {
  runIf?: string; // sha of the run-if commit, absent when no skip was scoping
  debug?: string; // sha of the DEBUG un-skip commit, absent when no skip was flakiness
  summary: string;
  feedback: Feedback[];
}

export interface PlanTryPushesReport {
  pushes: { purpose: string; tryArgs: string[]; rebuild: number }[];
  feedback: Feedback[];
}

export type TriageVerdict = "fixed" | "still failing" | "broken by patch" | "pre-existing" | "infra";

export interface TriageTryReport {
  cells: { test?: string; config?: string; taskId?: string; verdict: TriageVerdict; patch?: string; evidence: string }[];
  feedback: Feedback[];
}

export interface MergeClustersReport {
  groups: { message: string; tests: string[]; configs: string[]; from: string[]; reason: string }[];
  feedback: Feedback[];
}

export interface PriorArtVerdictReport {
  verdict: "active" | "reuse" | "none";
  bug?: number;
  quote: string;
  feedback: Feedback[];
}

export interface ReviseBugDraftReport {
  draft: BugDraft;
  feedback: Feedback[];
}

export interface ResolveConflictReport {
  state: "resolved" | "semantic";
  commit?: string; // the resolved commit's sha, when resolved
  explanation: string;
  feedback: Feedback[];
}

export interface EstimateReviewEffortReport {
  effort: number;
  reason: string;
  feedback: Feedback[];
}

export interface ReviewStackReport {
  findings: { patch: string; severity: "must-fix" | "nit"; text: string }[]; // patch: a commit sha of the stack
  addDeps: { patch: string; needs: string; kind: Dep["kind"]; reason: string }[];
  removeDeps: { patch: string; needs: string; reason: string }[];
  feedback: Feedback[];
}

export interface ClassifyReviewCommentsReport {
  comments: { id: number; kind: NonNullable<InlineComment["kind"]>; impliesChange: boolean }[];
  feedback: Feedback[];
}

export interface AdaptSoftDepReport {
  state: "adapted" | "not trivial";
  commits: string[];
  summary: string;
  feedback: Feedback[];
}
