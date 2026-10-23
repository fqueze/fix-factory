// Shared by the page and the orchestrator: when a request's stacks need a meta bug.
import type { PatchId, PatchView, RequestState } from "../types.ts";

// The skip-ifs group: its annotation patches are the only ones that go under the meta bug.
export const ANNOTATIONS_ITEM = "i-annotations";

// Only to land the annotation patches, which have no bug of their own; every other patch has one (an existing bug
// or a drafted one). Otherwise filing a meta bug, to track the stack's bugs, is up to you, and doesn't hold back
// submitting.
export function needsMetaBug(patches: Pick<PatchView, "bug" | "item">[]): boolean {
  return patches.some((p) => p.item === ANNOTATIONS_ITEM && (p.bug === null || p.bug === 0));
}

// A patch that isn't an annotation patch and has neither a bug nor a draft: its author still has to give it one.
export function lacksBug(p: Pick<PatchView, "bug" | "bugDraft" | "item">): boolean {
  return p.item !== ANNOTATIONS_ITEM && (p.bug === null || p.bug === 0) && !p.bugDraft;
}

// A patch, and the others of its group without a bug that share its bug draft: one bug for all of them.
export function sameBugDraft(s: RequestState, patch: PatchId): PatchView[] {
  const p = s.patches[patch];
  if (!p.bugDraft || p.bug !== null) return [p];
  const draft = JSON.stringify(p.bugDraft);
  return Object.values(s.patches).filter((x) => x.id === patch || (x.item === p.item && x.bug === null && x.bugDraft && JSON.stringify(x.bugDraft) === draft));
}
