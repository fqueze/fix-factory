import assert from "node:assert/strict";
import { it } from "node:test";
import { needsMetaBug } from "./meta-bug.ts";

const draft = { product: "Core", component: "XPCOM", summary: "s", description: "d", bugType: "defect" as const };

it("a meta bug only for a patch without a bug of its own", () => {
  assert.equal(needsMetaBug([1, 2, 3, 4, 5].map((bug) => ({ bug, bugDraft: undefined }))), false, "many patches with their bugs");
  assert.equal(needsMetaBug([{ bug: null, bugDraft: draft }]), false, "its bug is still to file");
  assert.equal(needsMetaBug([{ bug: 1, bugDraft: undefined }, { bug: null, bugDraft: undefined }]), true, "an annotation cleanup without its own bug");
});
