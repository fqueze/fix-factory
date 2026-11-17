import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filedBugs, matchFiledBugs, settledKeys, type PendingDraft } from "./bug-match.ts";
import type { RequestState } from "../types.ts";

const T = "2026-11-17T10:00:00.000Z";
const later = (min: number) => new Date(Date.parse(T) + min * 60_000).toISOString();

function request(bugs: Record<string, number | null>, meta?: number | null): RequestState {
  const patches = Object.fromEntries(Object.entries(bugs).map(([id, bug]) => [id, { id, bug, title: id, sha: "a", worktree: "/w", deps: [], replyDrafts: [] }]));
  return { id: "r-1", patches, ...(meta !== undefined ? { metaBug: { bug: meta } } : {}) } as unknown as RequestState;
}

const draft = (patch: string, summary: string, t = T): PendingDraft => ({ key: `r-1\n${patch}`, request: "r-1", patch, summary, title: `the ${patch} fix`, t });

describe("matching the bugs you filed to the drafts you followed", () => {
  it("gives a bug to the draft with its summary; one draft and one new bug go together; anything else waits for you", () => {
    const r = request({ "p-a": null, "p-b": null, "p-c": 2000001 });
    const get = (id: string) => (id === "r-1" ? r : undefined);
    const bugs = [
      { id: 2000001, summary: "Already p-c's", creation_time: later(1) },
      { id: 2000002, summary: "Intermittent  browser_a.js | timed out ", creation_time: later(2) },
      { id: 2000003, summary: "Something else", creation_time: later(3) },
    ];
    assert.deepEqual(matchFiledBugs([draft("p-a", "Intermittent browser_a.js | timed out"), draft("p-b", "B")], bugs, get), [
      { key: "r-1\np-a", request: "r-1", patch: "p-a", title: "the p-a fix", bug: 2000002 },
    ]);
    // One draft, its summary changed in Bugzilla: the one new bug (2000001 is a patch's already).
    assert.deepEqual(matchFiledBugs([draft("p-b", "B")], bugs.slice(0, 2), get).map((m) => m.bug), [2000002]);
    assert.deepEqual(matchFiledBugs([draft("p-b", "B")], bugs, get), [], "two new bugs: which?");
    assert.deepEqual(matchFiledBugs([draft("p-a", "A"), draft("p-b", "B")], bugs.slice(0, 2), get), [], "two drafts: which?");
    // A bug filed before the link was followed isn't from it.
    assert.deepEqual(matchFiledBugs([draft("p-b", "B", later(30))], bugs.slice(0, 2), get), []);
  });

  it("settles the drafts whose patch got a bug some other way, or is gone, or were followed too long ago", () => {
    const r = request({ "p-a": null, "p-b": 2000009 }, 2000010);
    const get = (id: string) => (id === "r-1" ? r : undefined);
    const now = Date.parse(T) + 60_000;
    assert.deepEqual(
      settledKeys([draft("p-a", "A"), draft("p-b", "B"), draft("meta", "M"), draft("p-gone", "G"), { ...draft("p-a", "A"), key: "old", t: "2026-11-17T06:00:00.000Z" }, { ...draft("p-a", "A"), key: "x", request: "r-nope" }], get, now),
      ["r-1\np-b", "r-1\nmeta", "r-1\np-gone", "old", "x"],
    );
  });

  it("asks Bugzilla once for the bugs assigned to you since then, their id, summary and creation time only", async () => {
    const urls: string[] = [];
    const fake = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ bugs: [{ id: 1, summary: "s", creation_time: T }] }));
    }) as typeof fetch;
    assert.deepEqual(await filedBugs("me@example.com", T, fake), [{ id: 1, summary: "s", creation_time: T }]);
    assert.equal(urls[0], `https://bugzilla.mozilla.org/rest/bug?assigned_to=me%40example.com&creation_time=${encodeURIComponent(T)}&include_fields=id%2Csummary%2Ccreation_time`);
  });
});
