import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { bugInfo, enterBugUrl, priorArt, priorArtQuery, revisionsFromAttachments } from "./bugzilla.ts";
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
  assert.equal(b.lastChangeTime, "2026-10-13T21:44:52Z");
  assert.equal(b.component, "Disability Access APIs");
  assert.deepEqual(b.revisions, [
    {
      revision: 333361,
      obsolete: false,
      title: "Bug 2081341 - Wait in addAccessibleTask until a remote document's cached bounds match its browser's size. r?Jamie",
      status: "needs-review",
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
    return new Response(JSON.stringify({ bugs: [{ id: 5, summary: "Intermittent x" }] }));
  }) as typeof fetch;
  assert.deepEqual(await bugInfo(5, fetchFn), { id: 5, summary: "Intermittent x", firstComment: "real text" });
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
});
