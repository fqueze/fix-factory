import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { FixtureStateSource } from "../state-source.ts";
import type { RequestState } from "../../types.ts";
import type { RenderContext } from "./common.ts";
import { renderOverview } from "./overview.ts";
import { renderRequest } from "./request.ts";

const FIXTURES = resolve(import.meta.dirname, "../../../test/fixtures/server");
const source = new FixtureStateSource(FIXTURES);
const ctx: RenderContext = {
  profilerOrigin: "http://localhost:4242",
  baseUrl: "http://factory:4300",
  now: Date.parse("2026-10-15T09:00:00Z"),
  maxAgents: 10,
  maxBuilds: 3,
  interdiff: (p) => readFileSync(resolve(FIXTURES, p.interdiffFile!), "utf8"),
};

function get(id: string): RequestState {
  const r = source.getRequest(id);
  assert.ok(r, id);
  return r;
}

function expanded(id: string): string {
  return renderRequest(get(id), ctx, true).value;
}

// The command JSON a form posts, as it appears in the escaped page.
function cmd(c: object): string {
  return JSON.stringify(c).replaceAll('"', "&quot;");
}

describe("overview", () => {
  const page = renderOverview(source.listRequests(), ctx);

  it("splits requests into active, queued and a collapsed archive", () => {
    const active = page.indexOf("<h2>Active");
    const queued = page.indexOf("<h2>Queued");
    const finished = page.indexOf("<h2>Finished");
    assert.ok(active >= 0 && active < queued && queued < finished);
    assert.match(page, /<details class="archive">/);
    assert.ok(page.indexOf("r-20260930-errorsummary") > finished, "done requests are in the archive");
    assert.ok(page.indexOf("r-20261016-popups") > queued && page.indexOf("r-20261016-popups") < finished);
    assert.ok(page.includes(cmd({ cmd: "start-now", request: "r-20261016-popups" })));
  });

  it("shows one line per active request with its step and Profile button", () => {
    assert.equal((page.match(/<details class="req/g) ?? []).length, 9);
    assert.match(page, /<span class="step">6 · verify on try<\/span>/);
    const url = encodeURIComponent("http://factory:4300/api/requests/r-20261005-newtab/profile");
    assert.ok(page.includes(`href="http://localhost:4242/from-url/${url}?thread=0"`));
  });

  it("has the header strip and the global Tell the factory box", () => {
    assert.match(page, /agents <b>5\/10<\/b>/);
    assert.match(page, /<b>8<\/b> requests need you/);
    assert.ok(page.includes(cmd({ cmd: "tell-factory" })));
    assert.doesNotMatch(page, /New request|new-request/);
  });

  it("archives text forwarded to an existing request, with where it went", () => {
    assert.ok(page.indexOf("r-20261015-lando-was-down-re-push") > page.indexOf("<h2>Finished"));
    assert.match(page, /<b>Lando was down this morning, re-push what failed<\/b> <span class="sub">· Forwarded to r-20261013-tab-failures.<\/span>/);
  });

  it("lists recent try pushes across requests", () => {
    assert.match(page, /<h2>Recent try pushes<\/h2>/);
    assert.match(page, /dbfcf15fdf1f<\/a><\/td><td class="hide-sm"><a href="\/requests\/r-20261005-newtab">newtab<\/a>/);
  });

  it("renders collapsed requests without their body", () => {
    assert.doesNotMatch(page, /class="rbody">/);
    assert.match(page, /data-lazy/);
  });
});

describe("one fixture per step of docs/MVP.md", () => {
  it("1. request: text from the main box, titled by its text, while route-request runs", () => {
    const h = expanded("r-20261015-sessionstore");
    assert.match(h, /1 · request/);
    assert.match(h, /<span class="rname">Burn down browser\/components\/sessionstore\/test, skip the mac pools for now<\/span>/);
    assert.match(h, /not routed yet/);
    assert.match(h, /route-request/);
  });

  it("2. first signal: approve the un-skip push, with its command and tasks", () => {
    const h = expanded("r-20261014-extensions-xpcshell");
    assert.match(h, /<b>platforms<\/b>: \[&quot;linux&quot;,&quot;windows&quot;\]/);
    assert.match(h, /<span class="flag">Approve the un-skip push<\/span>/);
    assert.ok(h.includes(cmd({ cmd: "approve-push", request: "r-20261014-extensions-xpcshell", push: "unskip" })));
    assert.match(h, /Command \+ tasks/);
    assert.match(h, /186 tasks/);
    assert.match(h, /--rebuild 10/);
  });

  it("3. work list: take it or hand it back", () => {
    const h = expanded("r-20261013-dom-indexeddb");
    assert.ok(h.includes(cmd({ cmd: "take-it", request: "r-20261013-dom-indexeddb", item: "i-idb-quota" })));
    assert.ok(h.includes(cmd({ cmd: "hand-back", request: "r-20261013-dom-indexeddb", item: "i-idb-quota" })));
    assert.match(h, />Take it</);
    assert.match(h, />Hand back</);
  });

  it("4. investigate and fix: item states, running agent, recovery plan with a checkbox per command", () => {
    const h = expanded("r-20261013-tab-failures");
    assert.match(h, /<span class="st run">investigating<\/span>/);
    assert.match(h, /opus · 6 h/);
    assert.match(h, /<span class="st find">review findings<\/span>/);
    assert.match(h, /<span class="st closed">handed back: bug 2081413, dao active<\/span>/);
    assert.match(h, /<span class="st wait">waiting for a build slot<\/span>/);
    const boxes = h.match(/<input type="checkbox" name="command"[^>]*>/g) ?? [];
    assert.equal(boxes.length, 2);
    assert.match(boxes[0], / checked>$/);
    assert.doesNotMatch(boxes[1], /checked/, "shell commands are opt-in");
    assert.match(h, /Run checked/);
    assert.ok(h.includes(cmd({ cmd: "reply-recovery", request: "r-20261013-tab-failures", job: "j-recover" })));
    assert.match(h, /Can't do: Read the profile/);
    assert.match(h, /Should the next attempt use a debug build\?/);
  });

  it("4. investigate and fix: Bug to file link and the paste-number/comment box", () => {
    const h = expanded("r-20261010-xpcshell-cwd");
    assert.match(h, /<a class="bug tofile" href="https:\/\/bugzilla\.mozilla\.org\/enter_bug\.cgi\?product=Core&amp;component=XPCOM&amp;short_desc=CopyDirectoryTo\+leaves/);
    assert.match(h, /blocked=2081200/);
    assert.match(h, /Bug draft · Core::XPCOM · “CopyDirectoryTo leaves a read-only source directory&#39;s contents behind”/);
    assert.ok(h.includes(cmd({ cmd: "set-bug", request: "r-20261010-xpcshell-cwd", patch: "p-copydir" })));
    assert.match(h, /name="bugOrText"/);
  });

  it("5. stack: patches in stack order, deps, effort and value", () => {
    const h = expanded("r-20261010-xpcshell-cwd");
    const order = ["p-prefs", "p-storage", "p-copydir", "p-fixture"].map((p) => h.indexOf(`data-patch="${p}"`));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.ok(order[0] > 0);
    assert.match(h, /<span class="bug none">Bug XXXXXXX<\/span> Save the prefs file of test_libPrefs\.js in the temp dir, r=gstoll\. <span class="sub">\(meta bug\)<\/span>/);
    assert.match(h, /⛔ hard: needs “Make nsLocalFile::CopyDirectoryTo/);
    assert.match(h, /🔗 soft: needs a newer sqlite on the try builders \(the vacuum test is slow without it\)/);
    assert.match(h, /<td class="num hide-sm">40\/wk<\/td>/);
    assert.match(h, /href="\/stacks\/storage-unit\/review"/);
  });

  it("6. verify on try: planned pushes with purpose and Approve, finished push with result", () => {
    const h = expanded("r-20261010-xpcshell-cwd");
    assert.match(h, /<td class="res plan">push A<\/td><td>Same configs and paths as the un-skip push/);
    assert.match(h, /Approve both/);
    assert.match(h, /<td class="res bad">291 failures, 12 groups<\/td>/);
    assert.equal((h.match(/<div class="action"/g) ?? []).length, 3, "one ⚑ area per open needs-user entry");
  });

  it("6. verify on try: a running push shows its progress", () => {
    assert.match(expanded("r-20261005-newtab"), /<td class="res run">412\/440, 0 failures<\/td>/);
  });

  it("7. meta bug: Bug to file, paste box and the checks blocking submission", () => {
    const h = expanded("r-20261008-permissions");
    assert.match(h, /Meta: Bug to file ↗/);
    assert.ok(h.includes(cmd({ cmd: "set-bug", request: "r-20261008-permissions", patch: "meta" })));
    assert.match(h, /<span class="bad">2 patches still say Bug XXXXXXX<\/span>/);
    assert.match(h, /data-copy="mozphab-r-20261008-permissions-[^"]*" disabled>Copy the moz-phab command<\/button>/);
  });

  it("8. submit: checks pass, stack-viewer link, moz-phab command to copy", () => {
    const h = expanded("r-20261007-focus");
    assert.doesNotMatch(h, /class="bad"/);
    assert.match(h, /Open in stack-viewer ↗/);
    assert.match(h, /<textarea hidden id="mozphab-r-20261007-focus-focus">cd [^<]+ &amp;&amp; moz-phab submit<\/textarea>/);
    assert.match(h, /data-copy="mozphab-r-20261007-focus-focus">Copy the moz-phab command<\/button>/);
    assert.doesNotMatch(h, /run-moz-phab/);
  });

  it("8. submit: the meta-bug comment can be copied, from the ⚑ area and from the stack", () => {
    const h = expanded("r-20261007-focus");
    assert.match(h, /<textarea hidden id="summary-r-20261007-focus-focus">\| Patch \| Effort \| Value \|/);
    assert.match(h, /data-copy="summary-r-20261007-focus-focus">Copy the meta-bug comment</);
    assert.match(h, /<textarea readonly rows="6" id="summary-r-20261007-focus-focus-body">/);
    assert.match(h, /data-copy="summary-r-20261007-focus-focus-body">Copy the meta-bug comment</);
    // Collapsed, the ⚑ area still has what it copies.
    const closed = renderRequest(get("r-20261007-focus"), ctx, false).value;
    assert.match(closed, /id="summary-r-20261007-focus-focus"/);
  });

  it("7. meta bug: the draft's bug type and keywords go into enter_bug.cgi", () => {
    const h = expanded("r-20261008-permissions");
    assert.match(h, /bug_type=task&amp;keywords=meta/);
  });

  it("buttons act on the stack and job the needs-user entry names", () => {
    const r = structuredClone(get("r-20261005-newtab"));
    r.stacks.other = { ...r.stacks.newtab, id: "other" };
    r.needsUser = [{ key: "resubmit:x", action: "Resubmit", detail: "", stack: "other", since: r.createdAt }];
    assert.match(renderRequest(r, ctx).value, /data-copy="mozphab-r-20261005-newtab-other"/);

    const t = structuredClone(get("r-20261013-tab-failures"));
    t.recoveryPlans.push({ ...t.recoveryPlans[0], job: "j-later", text: "a later plan", plan: [] });
    assert.match(renderRequest(t, ctx).value, /the browser_tabSpinner agent/, "the plan of the entry's job, not the latest");
  });

  it("reports an interdiff that can't be read", () => {
    const h = renderRequest(get("r-20261005-newtab"), { ...ctx, interdiff: () => undefined }, true).value;
    assert.match(h, /interdiffs\/p-sponsored\.diff can't be read/);
  });

  it("9. review comments: reviewers, interdiff, draft reply with Copy reply and Open comment", () => {
    const h = expanded("r-20261005-newtab");
    assert.match(h, /<a class="phab" href="https:\/\/phabricator\.services\.mozilla\.com\/D327101" title="D327101"/);
    assert.match(h, /<a class="bug" href="https:\/\/bugzilla\.mozilla\.org\/show_bug\.cgi\?id=2011958"[^>]*>Bug 2011958<\/a> Count the sponsored tiles/);
    assert.match(h, /<span class="rv block">mconley<\/span>/);
    assert.match(h, /<span class="rv pend">beth<\/span>/);
    assert.match(h, /<span class="r">-  let tiles = row\.querySelectorAll\(&quot;\.top-site-outer&quot;\);<\/span>/);
    assert.match(h, /<textarea rows="1" id="reply-p-sponsored-1873402">Done\.<\/textarea>/);
    assert.match(h, /data-copy="reply-p-sponsored-1873402">Copy reply</);
    assert.match(h, /href="https:\/\/phabricator\.services\.mozilla\.com\/D327101#inline-1873402"/);
    assert.ok(h.includes(cmd({ cmd: "comment-fix", request: "r-20261005-newtab", patch: "p-sponsored" })));
    assert.match(h, /1 landed ▸/);
  });

  it("10. landing: landable patches and the moz-phab command", () => {
    const h = expanded("r-20261001-mouse-button");
    assert.match(h, /<span class="landable">landable<\/span>/);
    assert.match(h, /Reorg ready/);
    assert.match(h, />Copy the moz-phab command</);
  });

  it("landable needs every hard dep landed or landable", () => {
    const h = expanded("r-20261005-newtab");
    const nimbus = h.slice(h.indexOf('data-patch="p-nimbus"'));
    assert.doesNotMatch(nimbus.slice(0, nimbus.indexOf("</tr>")), /landable/);
  });

  it("every request has a Tell the factory box", () => {
    for (const r of source.listRequests()) {
      assert.ok(renderRequest(r, ctx, true).value.includes(cmd({ cmd: "tell-factory", request: r.id })), r.id);
    }
  });
});

describe("escaping", () => {
  it("escapes every value from the state", () => {
    const r = structuredClone(get("r-20261005-newtab"));
    r.text = "<script>alert(1)</script>";
    r.folder = undefined;
    r.kind = "try-push";
    r.patches["p-sponsored"].title = 'Bug 1 - <img src=x onerror="alert(1)">';
    r.needsUser[0].detail = "</span><script>x</script>";
    const h = renderRequest(r, ctx, true).value;
    assert.doesNotMatch(h, /<script>|<img/);
    assert.match(h, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(h, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  });

  it("only links to https try push URLs", () => {
    const r = structuredClone(get("r-20261005-newtab"));
    r.pushes.v2.url = "javascript:alert(1)";
    r.pushes.v2.rev = "abc&x=<y>";
    const pages = [renderRequest(r, ctx, true).value, renderOverview([r], ctx)];
    for (const h of pages) {
      assert.doesNotMatch(h, /javascript:/);
      assert.ok(h.includes('href="https://treeherder.mozilla.org/jobs?repo=try&amp;revision=abc%26x%3D%3Cy%3E"'));
    }
  });
});
