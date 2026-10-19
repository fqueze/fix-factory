import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { bugInfo, describePriorArt, enterBugUrl, isBot, priorArt, priorArtQuery, revisionsFromAttachments } from "./bugzilla.ts";
import type { Conduit } from "./phab.ts";

const fixtures = new URL("../../test/fixtures/bugzilla/", import.meta.url);

function recorded(name: string): { fetch: typeof fetch; conduit: Conduit } {
  const { http, conduit } = JSON.parse(readFileSync(new URL(name, fixtures), "utf8"));
  return {
    fetch: (async (url: string) => {
      if (!(url in http)) throw new Error(`no fixture for ${url}`);
      return new Response(JSON.stringify(http[url]));
    }) as typeof fetch,
    conduit: async (method, params) => {
      const call = conduit.find((c: any) => c.method === method && isDeepStrictEqual(c.params, params));
      if (!call) throw new Error(`no fixture for ${method}`);
      return call.result;
    },
  };
}

test("priorArt: open bugs, assignee, attached revisions with their status", async () => {
  const r = recorded("prior-art-browser_test_general.json");
  const out = await priorArt("accessible/tests/browser/hittest/browser_test_general.js", r.fetch, r.conduit);
  assert.equal(out.query, "browser_test_general.js");
  assert.deepEqual(
    out.bugs.map((b) => [b.id, b.status, b.assignee]),
    [
      [1781926, "REOPENED", null],
      [2081341, "ASSIGNED", "florian@mozilla.com"],
    ],
  );
  const b = out.bugs[1];
  assert.deepEqual(b.lastHumanComment, { time: "2026-10-13T18:42:14Z", author: "florian@mozilla.com" });
  assert.equal(b.component, "Disability Access APIs");
  assert.deepEqual(b.revisions, [
    {
      revision: 333361,
      obsolete: false,
      title: "Bug 2081341 - Wait in addAccessibleTask until a remote document's cached bounds match its browser's size. r?Jamie",
      status: "needs-review",
      modified: "2026-10-14T01:42:09.000Z",
    },
  ]);
});

test("priorArt: no bugs, no conduit call", async () => {
  const fetchFn = (async () => new Response(JSON.stringify({ bugs: [] }))) as unknown as typeof fetch;
  const conduit: Conduit = async () => assert.fail("conduit called");
  assert.deepEqual(await priorArt("dir/test_x.html", fetchFn, conduit), { test: "dir/test_x.html", query: "test_x.html", bugs: [] });
});

test("priorArtQuery", () => {
  assert.equal(priorArtQuery("a/b/browser_c.js"), "browser_c.js");
  assert.equal(priorArtQuery("test_d.html"), "test_d.html");
});

test("revisionsFromAttachments ignores other attachments", () => {
  assert.deepEqual(
    revisionsFromAttachments([
      { content_type: "text/x-phabricator-request", file_name: "phabricator-D311087-url.txt", is_obsolete: 1 },
      { content_type: "text/plain", file_name: "log.txt", is_obsolete: 0 },
    ]),
    [{ revision: 311087, obsolete: true }],
  );
});

test("bugInfo: first non-empty comment, Bugzilla errors", async () => {
  const fetchFn = (async (url: string) => {
    if (url.endsWith("/comment?include_fields=text,count")) {
      return new Response(JSON.stringify({ bugs: { "5": { comments: [{ text: "", count: 0 }, { text: "real text", count: 1 }] } } }));
    }
    if (url.includes("bug/6")) {
      return new Response(JSON.stringify({ error: true, code: 102, message: "You are not authorized to access bug 6." }), { status: 401 });
    }
    return new Response(JSON.stringify({ bugs: [{ id: 5, summary: "Intermittent x", status: "RESOLVED", resolution: "FIXED" }] }));
  }) as typeof fetch;
  assert.deepEqual(await bugInfo(5, fetchFn), { id: 5, summary: "Intermittent x", status: "RESOLVED", resolution: "FIXED", firstComment: "real text" });
  await assert.rejects(bugInfo(6, fetchFn), /not authorized/);
});

test("enterBugUrl matches file-bug.py's encoding", () => {
  const url = enterBugUrl({
    product: "Core",
    component: "Disability Access APIs",
    summary: "Intermittent a/b/browser_x.js | Timeout (it's *bad*)!",
    description: "Line 1\nLine 2 & 100% ~ok",
    blocks: [123, 456],
  });
  // Output of build_url() in .claude/skills/bug-filing/file-bug.py for the same fields.
  assert.equal(
    url,
    "https://bugzilla.mozilla.org/enter_bug.cgi?product=Core&component=Disability%20Access%20APIs&short_desc=Intermittent%20a%2Fb%2Fbrowser_x.js%20%7C%20Timeout%20%28it%27s%20%2Abad%2A%29%21&comment=Line%201%0ALine%202%20%26%20100%25%20~ok&blocked=123&blocked=456",
  );
  const meta = enterBugUrl({ product: "Testing", component: "General", summary: "m", description: "d", bugType: "task", keywords: ["meta", "leave-open"] });
  assert.ok(meta.endsWith("&bug_type=task&keywords=meta%2C%20leave-open"), meta);
});

test("isBot: Bugzilla automation accounts", () => {
  for (const bot of ["intermittent-bug-filer@mozilla.bugs", "release-mgmt-account-bot@mozilla.tld", "update-bot@bmo.tld", "orangefactor@bots.tld"]) {
    assert.ok(isBot(bot), bot);
  }
  assert.ok(!isBot("florian@mozilla.com"));
});

test("describePriorArt: who is on the bug and its live revisions, in one line", () => {
  const bug = {
    id: 2079911,
    summary: "Intermittent test_quota.js | Quota exceeded",
    status: "ASSIGNED",
    product: "Core",
    component: "Storage: IndexedDB",
    keywords: [],
    assignee: "janv@mozilla.com",
    lastHumanComment: { time: "2026-10-12T08:00:00Z", author: "janv@mozilla.com" },
    revisions: [
      { revision: 1, obsolete: true, status: "abandoned" },
      { revision: 2, obsolete: false, status: "needs-review", modified: "2026-10-14T10:00:00Z" },
      { revision: 3, obsolete: false, status: "draft" },
    ],
  };
  assert.equal(
    describePriorArt(bug),
    "Bug 2079911 - Intermittent test_quota.js | Quota exceeded (ASSIGNED, assigned to janv@mozilla.com, last comment by janv@mozilla.com on 2026-10-12): D2 in review, updated 2026-10-14; D3 draft.",
  );
  assert.equal(describePriorArt({ ...bug, status: "NEW", assignee: null, lastHumanComment: null, revisions: [] }), "Bug 2079911 - Intermittent test_quota.js | Quota exceeded (NEW).");
});
