import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { arcToken, makeConduit, parseFileInfoReviewers, parseRevision, poll, reviewerStatus, reviewersCommand, stripBadge, unknownReviewers, type Conduit } from "./phab.ts";

const fixtures = new URL("../../test/fixtures/phab/", import.meta.url);

function recordedConduit(): Conduit {
  const calls = JSON.parse(readFileSync(new URL("poll-conduit.json", fixtures), "utf8")) as { method: string; params: unknown; result: unknown }[];
  return async (method, params) => {
    const call = calls.find((c) => c.method === method && isDeepStrictEqual(c.params, params));
    if (!call) throw new Error(`no fixture for ${method} ${JSON.stringify(params)}`);
    return call.result;
  };
}

test("poll: reviewers, inline comments, suggested edits, replies", async () => {
  const [d333041, d329684] = await poll([333041, 329684], recordedConduit());
  assert.equal(d333041.status, "published");
  assert.deepEqual(d333041.reviewers, [
    { name: "ahal", status: "pending" },
    { name: "jcristau", status: "accepted" },
  ]);
  assert.equal(d333041.comments.length, 2);
  assert.deepEqual(d333041.comments[0], {
    id: 1767043,
    author: "jcristau",
    file: "testing/mochitest/runtests.py",
    line: 365,
    length: 1,
    text: "same for the xpcshell hunk",
    done: true,
    suggestion: '            message.setdefault("extra", {})["will_retry"] = True\n',
  });

  assert.equal(d329684.status, "needs-revision");
  assert.deepEqual(d329684.reviewers, [
    { name: "#layout-reviewers", status: "blocking" },
    { name: "#firefox-animation-reviewers", status: "pending" },
    { name: "emilio", status: "blocking" },
  ]);
  const reply = d329684.comments.find((c) => c.id === 1763636);
  assert.equal(reply?.replyTo, 1763590);
  assert.equal(reply?.author, "dshin");
  assert.ok(d329684.comments.every((c) => c.suggestion === undefined && !c.done));
});

test("poll: unknown revision", async () => {
  const conduit: Conduit = async () => ({ data: [], cursor: { after: null } });
  await assert.rejects(poll([1], conduit), /not found: D1/);
});

test("makeConduit: request shape and errors", async () => {
  let seen: { url: string; body: URLSearchParams } | undefined;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen = { url, body: init.body as URLSearchParams };
    return new Response(JSON.stringify({ result: null, error_code: "ERR-CONDUIT-CORE", error_info: "nope" }));
  }) as typeof fetch;
  let tokenReads = 0;
  const conduit = makeConduit(fakeFetch, () => (tokenReads++, "api-secret"));
  await assert.rejects(conduit("user.whoami", { a: 1 }), /user\.whoami: ERR-CONDUIT-CORE: nope/);
  await assert.rejects(conduit("user.whoami", { a: 1 }));
  assert.equal(tokenReads, 1);
  assert.equal(seen?.url, "https://phabricator.services.mozilla.com/api/user.whoami");
  assert.deepEqual(JSON.parse(seen!.body.get("params")!), { a: 1, __conduit__: { token: "api-secret" } });
});

test("arcToken: clear error without a token for the host", () => {
  const dir = mkdtempSync(join(tmpdir(), "arcrc-test-"));
  try {
    const arcrc = join(dir, ".arcrc");
    writeFileSync(arcrc, JSON.stringify({ hosts: { "https://phabricator.services.mozilla.com/api/": { token: "api-x" } } }));
    assert.equal(arcToken(arcrc), "api-x");
    writeFileSync(arcrc, JSON.stringify({ hosts: {} }));
    assert.throws(() => arcToken(arcrc), /no token for https:\/\/phabricator\.services\.mozilla\.com\/api\/ in .*\.arcrc/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reviewerStatus", () => {
  assert.equal(reviewerStatus("accepted", "accepted"), "accepted");
  assert.equal(reviewerStatus("rejected", "needs-revision"), "blocking");
  // Requested changes on an older diff: the author updated it, the revision is back in review.
  assert.equal(reviewerStatus("rejected", "needs-review"), "pending");
  assert.equal(reviewerStatus("blocking", "needs-review"), "pending");
  assert.equal(reviewerStatus("added", "needs-review"), "pending");
  assert.equal(reviewerStatus("resigned", "needs-review"), "resigned");
});

test("stripBadge", () => {
  assert.equal(stripBadge("{nav, icon=check, name=Done} looks good\n"), "Done looks good");
  assert.equal(stripBadge("plain\n"), "plain");
});

test("parseRevision", () => {
  assert.equal(parseRevision("D123"), 123);
  assert.equal(parseRevision("456"), 456);
  assert.equal(parseRevision("https://phabricator.services.mozilla.com/D789"), 789);
  assert.throws(() => parseRevision("abc"));
});

test("reviewers: mach file-info reviewers --format json", () => {
  assert.deepEqual(reviewersCommand(["a.js"]), ["./mach", "file-info", "reviewers", "--format", "json", "a.js"]);
  const r = parseFileInfoReviewers(readFileSync(new URL("file-info-reviewers.json", fixtures), "utf8"));
  assert.equal(r.files.length, 2);
  assert.deepEqual(r.suggestions, [
    { name: "#places-reviewers", source: "mots", modules: ["Bookmarks & History"] },
    { name: "#sessionstore-reviewers", source: "mots", modules: ["Session Restore"] },
    { name: "#sessionstore-reviewers", source: "herald", blocking: false },
    { name: "#sessionstore-reviewers-rotation", source: "herald", blocking: true },
  ]);
  const recent = parseFileInfoReviewers(
    JSON.stringify({ files: ["x"], recent_groups: [{ name: "dom-core", count: 3 }], recent_individuals: [{ name: "smaug", count: 2 }] }),
  );
  assert.deepEqual(recent.suggestions, [
    { name: "#dom-core", source: "recent", count: 3 },
    { name: "smaug", source: "recent", count: 2 },
  ]);
});

test("unknownReviewers: names Phabricator doesn't know, groups by slug, blocking ! ignored", async () => {
  const asked: unknown[] = [];
  const conduit: Conduit = async (method, params) => {
    asked.push([method, params]);
    const data = method === "user.search" ? [{ fields: { username: "mkaply" } }] : [{ fields: { slug: "xpcshell-reviewers" } }];
    return { data, cursor: { after: null } };
  };
  assert.deepEqual(await unknownReviewers(["mkaply!", "nobody", "#xpcshell-reviewers", "#testing-reviewers"], conduit), ["nobody", "#testing-reviewers"]);
  assert.deepEqual(asked, [
    ["user.search", { constraints: { usernames: ["mkaply", "nobody"] } }],
    ["project.search", { constraints: { slugs: ["xpcshell-reviewers", "testing-reviewers"] } }],
  ]);
});
