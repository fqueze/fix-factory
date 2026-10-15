// The schemas of the prompts not covered by src/agents/schemas.test.ts, against their report types:
// typed samples must validate, and every object forbids extra properties, as in
// src/agents/schemas.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateReport, type JsonSchema } from "../agents/run.ts";
import type { AddressReviewReport } from "../types.ts";
import type * as R from "../types.ts";

const load = (name: string): JsonSchema => JSON.parse(readFileSync(fileURLToPath(new URL(`../../schemas/${name}.json`, import.meta.url)), "utf8"));
const prompts = (): string[] => Object.keys(JSON.parse(readFileSync(fileURLToPath(new URL("../../prompts/index.json", import.meta.url)), "utf8")));
const feedback = [{ target: "factory" as const, text: "the table file was empty" }];

const samples: Record<string, unknown[]> = {
  "route-request": [
    { kind: "burndown", folder: "dom/base/test", config: { folders: ["dom/base/test"], tests: [], platforms: ["linux"], constraints: [] }, questions: [], feedback } satisfies R.RouteRequestReport,
    { existing: "r-20261015-xpcshell-cwd", feedback: [] } satisfies R.RouteRequestReport,
  ],
  "classify-annotation": [{ kind: "scoping", reason: "no GPU on that config", feedback } satisfies R.ClassifyAnnotationReport],
  "write-annotation-patches": [{ runIf: "abc", debug: "def", summary: "two commits", feedback } satisfies R.WriteAnnotationPatchesReport, { summary: "nothing to change", feedback: [] } satisfies R.WriteAnnotationPatchesReport],
  "plan-try-pushes": [{ pushes: [{ purpose: "un-skip", tryArgs: ["fuzzy", "-q", "xpcshell"], rebuild: 10 }], feedback } satisfies R.PlanTryPushesReport],
  "triage-try": [{ cells: [{ test: "a.js", config: "linux", verdict: "broken by patch", patch: "abc", evidence: "TEST-UNEXPECTED-FAIL" }, { taskId: "T", verdict: "infra", evidence: "worker lost" }], feedback } satisfies R.TriageTryReport],
  "merge-clusters": [{ groups: [{ message: "m", tests: ["a.js"], configs: ["c"], from: ["k1", "k2"], reason: "same crash" }], feedback } satisfies R.MergeClustersReport],
  "prior-art-verdict": [{ verdict: "reuse", bug: 123, quote: "open, no assignee", feedback } satisfies R.PriorArtVerdictReport],
  "revise-bug-draft": [{ draft: { product: "Core", component: "DOM", summary: "s", description: "d", keywords: ["intermittent-failure"], bugType: "defect" }, feedback } satisfies R.ReviseBugDraftReport],
  "resolve-conflict": [{ state: "resolved", commit: "abc", explanation: "kept both", feedback } satisfies R.ResolveConflictReport],
  "estimate-review-effort": [{ effort: 3, reason: "product change", feedback } satisfies R.EstimateReviewEffortReport],
  "review-stack": [{ findings: [{ patch: "abc", severity: "must-fix", text: "same approach twice" }], addDeps: [{ patch: "abc", needs: "def", kind: "hard", reason: "helper" }], removeDeps: [], feedback } satisfies R.ReviewStackReport],
  "classify-review-comments": [{ comments: [{ id: 1, kind: "question", impliesChange: false }], feedback } satisfies R.ClassifyReviewCommentsReport],
  "address-review": [{ state: "addressed", summary: "s", commits: ["abc"], replies: [{ commentId: 1, text: "Because…" }], feedback } satisfies AddressReviewReport],
  "adapt-soft-dep": [{ state: "adapted", commits: ["a", "b"], summary: "s", feedback } satisfies R.AdaptSoftDepReport],
};

test("every prompt has a schema", () => {
  for (const name of prompts()) assert.ok(load(name).properties?.feedback, name);
});

test("the new schemas accept their typed samples", () => {
  for (const [name, list] of Object.entries(samples)) {
    for (const sample of list) assert.deepEqual(validateReport(load(name), sample), [], name);
  }
});

test("the new schemas forbid extra properties and require feedback", () => {
  const walk = (s: JsonSchema, path: string) => {
    if (s.type === "object") assert.equal(s.additionalProperties, false, path);
    for (const [k, v] of Object.entries(s.properties ?? {})) walk(v, `${path}.${k}`);
    if (s.items) walk(s.items, `${path}[]`);
  };
  for (const name of Object.keys(samples)) {
    walk(load(name), name);
    assert.ok(load(name).required?.includes("feedback"), name);
  }
  assert.equal(validateReport(load("estimate-review-effort"), { effort: 6, reason: "r", feedback: [] }).length, 1);
});
