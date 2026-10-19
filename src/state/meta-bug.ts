// Shared by the page and the orchestrator: when a request's stacks need a meta bug.
import type { PatchView } from "../types.ts";

// Only to land patches without a bug of their own (annotation cleanups): they go under the meta bug. Otherwise
// filing one, to track the stack's bugs, is up to you, and doesn't hold back submitting.
export function needsMetaBug(patches: Pick<PatchView, "bug" | "bugDraft">[]): boolean {
  return patches.some((p) => (p.bug === null || p.bug === 0) && !p.bugDraft);
}
