import assert from "node:assert/strict";
import { it } from "node:test";
import { ANNOTATIONS_ITEM, lacksBug, needsMetaBug } from "./meta-bug.ts";

const draft = { product: "Core", component: "XPCOM", summary: "s", description: "d", bugType: "defect" as const };

it("a meta bug only for the annotation patches, which have no bug of their own", () => {
  assert.equal(needsMetaBug([1, 2, 3, 4, 5].map((bug) => ({ bug, item: "i-a" }))), false, "many patches with their bugs");
  assert.equal(needsMetaBug([{ bug: null, item: "i-a" }]), false, "a fix without a bug needs its own, not the meta bug");
  assert.equal(needsMetaBug([{ bug: 1, item: "i-a" }, { bug: null, item: ANNOTATIONS_ITEM }]), true, "an annotation cleanup");
});

it("every other patch needs a bug or a draft", () => {
  assert.equal(lacksBug({ bug: null, bugDraft: undefined, item: "i-a" }), true, "a test-only fix too");
  assert.equal(lacksBug({ bug: null, bugDraft: draft, item: "i-a" }), false);
  assert.equal(lacksBug({ bug: 7, bugDraft: undefined, item: "i-a" }), false);
  assert.equal(lacksBug({ bug: null, bugDraft: undefined, item: ANNOTATIONS_ITEM }), false);
});
