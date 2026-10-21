// Shared by the page and the orchestrator: when a request's stacks need a meta bug.
import type { PatchView } from "../types.ts";

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
