// Checks schemas/*.json against the report types in src/types.ts. The samples are typed with those types, and the
// enum lists below fail typecheck if they drift from the type unions, so a type change forces a schema change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateReport, type JsonSchema } from "./run.ts";
import type { Feedback, InvestigateReport, ItemState, PlannedCommand, RecoverReport, RequestStep, ReviewPatchReport } from "../types.ts";

const load = (name: string): JsonSchema =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../schemas/${name}.json`, import.meta.url)), "utf8"));
const investigate = load("investigate-and-fix");
const review = load("review-patch");
const recover = load("recover");

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
function exact<T>() {
  return <const L extends readonly T[]>(list: L & (Same<L[number], T> extends true ? unknown : never)) => list;
}

const feedbackTargets = exact<Feedback["target"]>()(["fx-tests", "profiler-cli", "searchfox-cli", "factory", "inputs"]);
const investigateStates = exact<InvestigateReport["state"]>()(["fix verified locally", "left as-is", "handed back", "blocked", "not reproduced", "needs a try repro"]);
const verdicts = exact<ReviewPatchReport["verdict"]>()(["ok", "findings"]);
const severities = exact<ReviewPatchReport["findings"][number]["severity"]>()(["must-fix", "nit"]);
const plannedCmds = exact<PlannedCommand["cmd"]>()([
  "retry-job", "cancel-job", "resume-agent", "start-agent", "set-state", "redo-step", "edit-config", "shell", "hand-off", "split-request", "move-groups",
]);
const itemStates = exact<ItemState>()([
  "not started", "waiting for a build slot", "investigating", "fix verified locally", "in critical review",
  "review findings", "reviewed", "in stack", "in try", "waiting for review", "addressing review comments", "blocked", "waiting for a try repro",
  "fixed", "left as-is", "handed back", "taken over", "landed",
]);
const requestSteps = exact<RequestStep>()([
  "request", "first signal", "work list", "investigate and fix", "stack", "verify on try", "meta bug", "submit",
  "review comments", "landing", "done",
]);

const props = (s: JsonSchema | undefined) => s?.properties ?? {};
const planBranches = recover.properties!.plan.items!.anyOf!;
const branch = (cmd: string) => planBranches.find((b) => props(b).cmd.enum?.[0] === cmd)!;

test("schema enums match the type unions", () => {
  for (const s of [investigate, review, recover]) {
    assert.deepEqual(props(s.properties!.feedback.items).target.enum, feedbackTargets);
  }
  assert.deepEqual(investigate.properties!.state.enum, investigateStates);
  assert.deepEqual(review.properties!.verdict.enum, verdicts);
  assert.deepEqual(props(review.properties!.findings.items).severity.enum, severities);
  assert.deepEqual(planBranches.map((b) => props(b).cmd.enum), plannedCmds.map((c) => [c]));
  assert.deepEqual(props(branch("set-state")).state.enum, itemStates);
  assert.deepEqual(props(branch("redo-step")).step.enum, requestSteps);
});

test("every object in the schemas forbids extra properties, except free-form config", () => {
  const walk = (s: JsonSchema, path: string) => {
    if (s.type === "object" && path !== "$.plan[].config") assert.equal(s.additionalProperties, false, path);
    for (const [k, v] of Object.entries(s.properties ?? {})) walk(v, `${path}.${k}`);
    if (s.items) walk(s.items, `${path}[]`);
    for (const b of s.anyOf ?? []) walk(b, path);
  };
  for (const s of [investigate, review, recover]) walk(s, "$");
});

const feedback: Feedback[] = [{ target: "fx-tests", text: "the failure list missed a config" }];

const investigateSample: InvestigateReport = {
  state: "fix verified locally",
  summary: "Wait for the popup before clicking",
  cause: "The test clicked before popupshown.",
  evidence: [{ source: "profile", finding: "The click lands 40 ms before popupshown." }],
  verification: "Passed 50 times with --verify.",
  reproduction: { reproduced: true, where: "locally", widened: false, before: "6 of 20 runs", after: "0 of 100" },
  files: { evidence: "artifacts/evidence.md", reproduction: "artifacts/reproduction.md" },
  commits: ["0123abc", "4567def"],
  bugDrafts: [
    { commits: ["0123abc"], draft: { product: "Firefox", component: "General", summary: "Intermittent foo", description: "...", blocks: [123], bugType: "defect" } },
    { commits: ["4567def"], draft: { product: "Testing", component: "Mochitest", summary: "Print leak paths", description: "...", bugType: "enhancement" } },
  ],
  landsAfter: [{ what: "D12345", reason: "uses its helper" }],
  feedback,
};

const reviewSample: ReviewPatchReport = {
  verdict: "findings",
  findings: [{ severity: "must-fix", file: "a.js", line: 12, text: "race remains" }, { severity: "nit", text: "typo" }],
  feedback: [],
};

const recoverSample: RecoverReport = {
  answer: "I'll retry the stuck jobs and restart the investigation.",
  plan: [
    { cmd: "retry-job", job: "j1", reason: "network" },
    { cmd: "cancel-job", job: "j2", reason: "stuck" },
    { cmd: "resume-agent", item: "i1", message: "stop and report", reason: "6 hours" },
    { cmd: "start-agent", item: "i1", prompt: "investigate-and-fix", reason: "fresh start" },
    { cmd: "set-state", item: "i2", state: "handed back", reason: "user asked" },
    { cmd: "redo-step", step: "stack", reason: "order was wrong" },
    { cmd: "redo-step", item: "i3", step: "investigate and fix", reason: "new info" },
    { cmd: "edit-config", config: { maxAgents: 2 }, reason: "too many" },
    { cmd: "shell", cwd: "/w", command: "git status", reason: "inspect" },
  ],
  cannotDo: ["rebase the meta bug"],
  questions: [],
  feedback,
};

test("schemas accept valid samples", () => {
  assert.deepEqual(validateReport(investigate, investigateSample), []);
  const { bugDrafts: _, ...noBugDraft } = investigateSample;
  assert.deepEqual(validateReport(investigate, noBugDraft), []);
  assert.deepEqual(validateReport(review, reviewSample), []);
  assert.deepEqual(validateReport(review, { verdict: "ok", findings: [], feedback: [] }), []);
  assert.deepEqual(validateReport(recover, recoverSample), []);
});

test("investigate-and-fix schema rejects common mistakes", () => {
  const { feedback: _, ...noFeedback } = investigateSample;
  assert.deepEqual(validateReport(investigate, noFeedback), ["$.feedback: required"]);
  assert.deepEqual(validateReport(investigate, { ...investigateSample, state: "fixed" }).length, 1);
  assert.deepEqual(validateReport(investigate, { ...investigateSample, commits: "0123abc" }), ["$.commits: expected array, got string"]);
  assert.deepEqual(validateReport(investigate, { ...investigateSample, landsAfter: ["D12345"] }), ["$.landsAfter[0]: expected object, got string"]);
  assert.deepEqual(validateReport(investigate, { ...investigateSample, bugDrafts: [{ commits: ["0123abc"], draft: { product: "Firefox" } }] }), [
    "$.bugDrafts[0].draft.component: required",
    "$.bugDrafts[0].draft.summary: required",
    "$.bugDrafts[0].draft.description: required",
    "$.bugDrafts[0].draft.bugType: required",
  ]);
  assert.deepEqual(validateReport(investigate, { ...investigateSample, bugDraft: investigateSample.bugDrafts![0].draft }), ["$.bugDraft: unexpected property"], "one draft per commit now");
  assert.deepEqual(validateReport(investigate, { ...investigateSample, feedback: [{ target: "mach", text: "x" }] }).length, 1);
  assert.deepEqual(validateReport(investigate, { ...investigateSample, bug: 123 }), ["$.bug: unexpected property"]);
  assert.deepEqual(validateReport(investigate, { ...investigateSample, evidence: [{ source: "hunch", finding: "x" }] }).length, 1);
  assert.deepEqual(validateReport(investigate, { ...investigateSample, reproduction: { before: "y" } }), ["$.reproduction.reproduced: required", "$.reproduction.where: required", "$.reproduction.widened: required"]);
  assert.deepEqual(validateReport(investigate, { ...investigateSample, files: { evidence: "e.md" } }), ["$.files.reproduction: required"]);
});

test("review-patch schema rejects common mistakes", () => {
  assert.deepEqual(validateReport(review, { ...reviewSample, verdict: "approved" }).length, 1);
  assert.deepEqual(validateReport(review, { ...reviewSample, findings: [{ severity: "major", text: "x" }] }).length, 1);
  assert.deepEqual(validateReport(review, { ...reviewSample, findings: [{ severity: "nit", line: "12", text: "x" }] }), [
    "$.findings[0].line: expected integer, got string",
  ]);
  assert.deepEqual(validateReport(review, { verdict: "ok", findings: [] }), ["$.feedback: required"]);
});

test("recover schema rejects common mistakes", () => {
  const plan = (p: unknown) => validateReport(recover, { ...recoverSample, plan: [p] });
  assert.deepEqual(plan({ cmd: "retry-job", job: "j1" }), ["$.plan[0].reason: required"]);
  assert.deepEqual(plan({ cmd: "set-state", item: "i", state: "done", reason: "r" }).length, 1);
  assert.ok(plan({ cmd: "delete-everything", reason: "r" }).length > 0);
  assert.deepEqual(plan({ cmd: "shell", command: "ls", reason: "r" }), ["$.plan[0].cwd: required"]);
  assert.deepEqual(validateReport(recover, { ...recoverSample, cannot_do: [] }), ["$.cannot_do: unexpected property"]);
  const { answer: _a, ...noAnswer } = recoverSample;
  assert.deepEqual(validateReport(recover, noAnswer), ["$.answer: required"]);
});
