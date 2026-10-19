import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  blankSecondLine,
  unknownReviewerViolations,
  bodyLength,
  descriptionLength,
  firstLineFormat,
  lint,
  lintBug,
  lintCommit,
  lintReply,
  noAiAttribution,
  noCauseClaims,
  noFileLineRefs,
  noHedging,
  noMeasurements,
  noStackCrossRefs,
  noTryLinks,
  replyLength,
  requiredFields,
  reviewerGroupHash,
  reviewerNotRequest,
  summaryLength,
} from "./lint-text.ts";

const fixture = (name: string) => readFileSync(new URL(`../../test/fixtures/lint-text/${name}`, import.meta.url), "utf8");
const rules = (r: { violations: { rule: string }[] }) => [...new Set(r.violations.map((v) => v.rule))].sort();

test("firstLineFormat", () => {
  assert.deepEqual(firstLineFormat(["Bug 123 - Do it, r=foo."]), []);
  assert.deepEqual(firstLineFormat(["Bug XXXXXXX - Do it, r=#foo-reviewers,bar."]), []);
  assert.deepEqual(firstLineFormat(["Bug 123 - Do it, r=foo!,bar."]), []);
  assert.deepEqual(firstLineFormat(["Bug 123 - Do it, r=foo, bar."]), []);
  for (const bad of [
    "Bug 123 - Do it r=foo.",
    "Bug 123 - Do it, r=foo",
    "Bug 123: Do it, r=foo.",
    "Do it, r=foo.",
    "Bug 123 - Do it, r=ai-frontend-reviewers, r=x.",
  ]) {
    assert.equal(firstLineFormat([bad]).length, 1, bad);
  }
});

test("reviewerNotRequest", () => {
  assert.equal(reviewerNotRequest(["Bug 1 - x, r?foo."]).length, 1);
  assert.deepEqual(reviewerNotRequest(["Bug 1 - x, r=foo."]), []);
});

test("reviewerGroupHash", () => {
  assert.deepEqual(reviewerGroupHash(["Bug 1 - x, r=#dom-core-reviewers,smaug."]), []);
  const v = reviewerGroupHash(["Bug 1 - x, r=dao, sessionstore-reviewers."]);
  assert.equal(v.length, 1);
  assert.match(v[0].text, /#sessionstore-reviewers/);
});

test("blankSecondLine", () => {
  assert.deepEqual(blankSecondLine(["Bug 1 - x, r=a.", "", "body"]), []);
  assert.equal(blankSecondLine(["Bug 1 - x, r=a.", "body"]).length, 1);
});

test("bodyLength ignores blank lines and trailers", () => {
  const body = Array.from({ length: 8 }, (_, i) => `line ${i}`);
  assert.deepEqual(bodyLength(["t", "", ...body, "", "Differential Revision: https://phabricator.services.mozilla.com/D1"]), []);
  assert.equal(bodyLength(["t", "", ...body, "one more"]).length, 1);
});

test("noFileLineRefs", () => {
  assert.equal(noFileLineRefs(["see dom/base/Foo.cpp:359-363"]).length, 1);
  assert.equal(noFileLineRefs(["browser_foo.js:12 fails"]).length, 1);
  assert.deepEqual(noFileLineRefs(["listens on localhost:8080", "Foo.cpp is fine"]), []);
});

test("noTryLinks", () => {
  assert.equal(noTryLinks(["https://treeherder.mozilla.org/jobs?repo=try&revision=abc"]).length, 1);
  assert.equal(noTryLinks(["https://hg.mozilla.org/try/rev/abc"]).length, 1);
  assert.equal(noTryLinks(["https://firefox-ci-tc.services.mozilla.com/tasks/abc"]).length, 1);
  assert.deepEqual(noTryLinks(["Try to wait for the load", "Fix the treeherder log parser", "Use the taskcluster proxy"]), []);
});

test("noMeasurements", () => {
  assert.equal(noMeasurements(["fails 12/12"]).length, 1);
  assert.equal(noMeasurements(["20.7% of runs"]).length, 1);
  assert.equal(noMeasurements(["4 out of 15"]).length, 1);
  assert.deepEqual(noMeasurements(["Bug 1787024 - x, r=a.", "Differential Revision: https://phabricator.services.mozilla.com/D333321"]), []);
});

test("noHedging", () => {
  assert.equal(noHedging(["This lets X go, which this patch does not do."]).length, 1);
  assert.equal(noHedging(["One datum points the other way."]).length, 1);
  assert.deepEqual(noHedging(["Wait for the flush."]), []);
});

test("noCauseClaims", () => {
  assert.equal(noCauseClaims(["The root cause is in docshell."]).length, 1);
  assert.equal(noCauseClaims(["Fixing that belongs in sessionstore."]).length, 1);
  assert.deepEqual(noCauseClaims(["The flush can arrive late."]), []);
});

test("noStackCrossRefs", () => {
  assert.equal(noStackCrossRefs(["the mac one goes in the last commit of this series"]).length, 1);
  assert.equal(noStackCrossRefs(["The previous patch handles it."]).length, 1);
  assert.deepEqual(noStackCrossRefs(["Wait for the previous task's tabs.", "The last commit to touch this file", "Keep the first patch of the observer"]), []);
});

test("noAiAttribution", () => {
  assert.equal(noAiAttribution(["Co-Authored-By: Claude Opus <noreply@anthropic.com>"]).length, 1);
  assert.equal(noAiAttribution(["\u{1F916} Generated with [Claude Code](https://claude.com/claude-code)"]).length, 1);
  assert.deepEqual(noAiAttribution(["Use the AI window's tab."]), []);
});

test("lintCommit: good message and placeholder pass", () => {
  assert.deepEqual(lintCommit(fixture("commit-good.txt")), { ok: true, violations: [] });
  assert.deepEqual(lintCommit("Bug XXXXXXX - Remove the dead skip-if conditions, r=#sessionstore-reviewers.\n").ok, true);
});

test("lintCommit: a real long message only trips bodyLength", () => {
  assert.deepEqual(rules(lintCommit(fixture("commit-long-body.txt"))), ["bodyLength"]);
});

test("lintCommit: bad message", () => {
  const r = lintCommit(fixture("commit-bad.txt"));
  assert.equal(r.ok, false);
  assert.deepEqual(rules(r), [
    "blankSecondLine",
    "firstLineFormat",
    "noAiAttribution",
    "noCauseClaims",
    "noFileLineRefs",
    "noHedging",
    "noMeasurements",
    "noStackCrossRefs",
    "noTryLinks",
    "reviewerNotRequest",
  ]);
  const tl = r.violations.find((v) => v.rule === "noTryLinks");
  assert.equal(tl?.line, 3);
});

test("bug drafts", () => {
  const ok = { product: "Firefox", component: "Session Restore", summary: "Intermittent browser_foo.js | timeout", description: "Short." };
  assert.deepEqual(lintBug(ok), { ok: true, violations: [] });
  assert.deepEqual(requiredFields({ product: "Firefox", summary: "x", description: "y" }), [{ rule: "requiredFields", text: "missing component" }]);
  assert.equal(summaryLength("x".repeat(151)).length, 1);
  assert.deepEqual(rules(lintBug({ ...ok, summary: "Fix it \u{1F916} Generated with Claude" })), ["noAiAttribution"]);
  assert.equal(descriptionLength(Array(9).fill("l").join("\n")).length, 1);
  assert.deepEqual(descriptionLength(Array(8).fill("l").join("\n\n")), []);
  assert.deepEqual(rules(lint("bug", JSON.stringify({ ...ok, component: "" }))), ["requiredFields"]);
});

test("replies", () => {
  assert.deepEqual(lintReply("Done, thanks."), { ok: true, violations: [] });
  assert.equal(replyLength("x".repeat(801)).length, 1);
  assert.deepEqual(rules(lintReply("  ")), ["replyLength"]);
  assert.throws(() => lint("poem", "x"), /unknown kind/);
});

test("unknownReviewerViolations: names Phabricator doesn't know; unreachable, no violation", async () => {
  const msg = "Bug 1 - Fix it, r=mkaply, #testing-reviewers.\n\nBody.\n";
  let asked: string[] = [];
  const v = await unknownReviewerViolations(msg, async (names) => ((asked = names), ["#testing-reviewers"]));
  assert.deepEqual(asked, ["mkaply", "#testing-reviewers"]);
  assert.deepEqual(v.map((x) => [x.rule, x.line]), [["unknownReviewer", 1]]);
  assert.match(v[0].text, /no user or group #testing-reviewers/);
  assert.deepEqual(await unknownReviewerViolations(msg, async () => { throw new Error("no token"); }), []);
});
