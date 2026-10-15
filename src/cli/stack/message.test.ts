import { test } from "node:test";
import assert from "node:assert/strict";
import { editMessage, isTestOnly, parseBug, parseReviewers, parseRevision } from "./message.ts";
import { summary } from "./summary.ts";

test("parses bug, reviewers and revision", () => {
  assert.equal(parseBug("Bug 1234567 - Fix it, r=a."), 1234567);
  assert.equal(parseBug("Bug XXXXXXX - Fix it, r=a."), null);
  assert.equal(parseBug("WIP - Fix it"), null);
  assert.deepEqual(parseReviewers("Bug 1 - Fix it, r=mconley,#home-newtab-reviewers."), ["mconley", "#home-newtab-reviewers"]);
  assert.deepEqual(parseReviewers("Bug 1 - Fix it, r?foo!,bar."), ["foo", "bar"]);
  assert.deepEqual(parseReviewers("Bug 1 - Fix it"), []);
  assert.equal(parseRevision("T\n\nbody\n\nDifferential Revision: https://phabricator.services.mozilla.com/D123456\n"), 123456);
  assert.equal(parseRevision("T\n\nsee D123456\n"), undefined);
});

test("test-only heuristic", () => {
  assert.ok(isTestOnly(["browser/components/foo/test/browser/browser_x.js", "browser/components/foo/test/browser/browser.toml"]));
  assert.ok(isTestOnly(["dom/base/test/unit/test_x.js", "dom/base/test/unit/xpcshell.toml"]));
  assert.ok(isTestOnly(["testing/web-platform/meta/css/foo.html.ini", "testing/web-platform/tests/css/foo.html"]));
  assert.ok(!isTestOnly(["testing/mochitest/browser-test.js"]));
  assert.ok(!isTestOnly(["browser/components/foo/Foo.sys.mjs", "browser/components/foo/test/browser/browser_x.js"]));
  assert.ok(!isTestOnly([]));
});

test("message edits replace the placeholder and keep the trailer", () => {
  const msg = "Bug XXXXXXX - Fix it, r=a.\n\nAlso see Bug XXXXXXX.\n\nDifferential Revision: https://phabricator.services.mozilla.com/D5\n";
  assert.equal(editMessage(msg, { bug: 42 }), "Bug 42 - Fix it, r=a.\n\nAlso see Bug 42.\n\nDifferential Revision: https://phabricator.services.mozilla.com/D5\n");
  assert.equal(editMessage(msg, { message: "Bug 7 - Better, r=a." }), "Bug 7 - Better, r=a.\n\nDifferential Revision: https://phabricator.services.mozilla.com/D5\n");
  assert.equal(editMessage("Bug 1 - X, r=a.\n", { bug: 2 }), "Bug 2 - X, r=a.\n");
});

test("summary table and meta-bug comment in stack order", () => {
  const out = summary({
    folder: "dom/base/test",
    patches: [
      { id: "a", title: "Bug 11 - Fix a | b, r=x.", bug: 11, revision: 5, effort: 2, value: 3.14159, repro: "chaos mode" },
      { id: "b", title: "Bug XXXXXXX - Fix b, r=y.", bug: null, effort: 1, value: 1 },
    ],
    order: ["b", "a"],
  });
  assert.equal(
    out.markdown,
    [
      "| # | Patch | Effort | Failures/week | Repro |",
      "|---|---|---|---|---|",
      "| 1 | Bug to file - Fix b | 1 | 1 |  |",
      "| 2 | [Bug 11](https://bugzilla.mozilla.org/show_bug.cgi?id=11) - Fix a \\| b ([D5](https://phabricator.services.mozilla.com/D5)) | 2 | 3.1 | chaos mode |",
      "",
    ].join("\n"),
  );
  assert.match(out.metaComment, /^This stack fixes intermittent failures in dom\/base\/test: 2 patches, about 4.1 failures\/week in total\./);
  assert.ok(out.metaComment.indexOf("Fix b") < out.metaComment.indexOf("Fix a"));
  assert.match(out.metaComment, /- Bug 11: Fix a \| b \(effort 2\/5, 3.1 failures\/week\)\. Repro: chaos mode/);
});
