import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { FixtureStateSource } from "../state-source.ts";
import type { RequestState } from "../../types.ts";
import { jobLabel, type RenderContext } from "./common.ts";
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
    assert.equal((page.match(/<details class="req/g) ?? []).length, 10);
    assert.match(page, /<span class="step">6 · verify on try<\/span>/);
    const url = encodeURIComponent("http://factory:4300/api/requests/r-20261005-newtab/profile");
    assert.ok(page.includes(`href="http://localhost:4242/from-url/${url}?thread=0"`));
  });

  it("has the header strip and the global Tell the factory box", () => {
    assert.match(page, /agents <b>8\/10<\/b>/);
    assert.match(page, /<b>8<\/b> requests need you/);
    assert.ok(page.includes(cmd({ cmd: "tell-factory" })));
    assert.doesNotMatch(page, /New request|new-request/);
  });

  it("archives text from the main box that was forwarded, or rephrased after it couldn't be routed, with what became of it", () => {
    assert.ok(page.indexOf("r-20261015-lando-was-down-re-push") > page.indexOf("<h2>Finished"));
    assert.match(page, /<b>Lando was down this morning, re-push what failed<\/b> <span class="sub">· Forwarded to r-20261013-tab-failures<\/span>/);
    assert.ok(page.indexOf("r-20261015-hmm") > page.indexOf("<h2>Finished"));
    assert.match(page, /<b>hmm<\/b> <span class="sub">· Superseded by r-20261015-sessionstore<\/span>/);
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
    assert.match(h, /<b>platforms<\/b>: linux, windows/);
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
    assert.match(h, /investigating<\/span><span class="sub"> · Opus · <span data-since="[^"]+">6 h<\/span><\/span>/);
    assert.match(h, /<span class="st find">review findings<\/span>/);
    assert.match(h, /<span class="st closed">handed back<\/span><span class="detail">: bug 2081413, dao active<\/span>/);
    assert.match(h, /<span class="st wait">waiting for a build slot<\/span>/);
    const boxes = h.match(/<input type="checkbox" name="command"[^>]*>/g) ?? [];
    assert.equal(boxes.length, 8);
    assert.match(boxes[0], / checked>$/);
    assert.doesNotMatch(boxes[7], /checked/, "shell commands are opt-in");
    assert.match(h, /Run checked/);
    assert.ok(h.includes(cmd({ cmd: "reply-recovery", request: "r-20261013-tab-failures", job: "j-recover" })));
    assert.match(h, /Can't do: Read the profile/);
    assert.match(h, /Should the next attempt use a debug build\?/);
  });

  it("4. investigate and fix: one plain-words line per planned command, its reason clamped, notes after the list", () => {
    const h = expanded("r-20261013-tab-failures");
    const labels = [...h.matchAll(/<li><label title="([^"]*)"><input type="checkbox"[^>]*> (.*?)<\/label><span class="reason clamp1" data-expand>/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(
      labels.map(([title]) => title),
      [
        "tell browser_tabSpinner.js’s author: “Stop and report what you have.”",
        "restart the investigation of browser_pinnedTabs.js: “Start over from the worktree as it is; the profile of task Zx3 is gone.”",
        "mark browser_mute.js as left as-is",
        "retry fetch test artifacts of browser_tab_drag_drop.js",
        "stop the investigation of browser_tabSpinner.js",
        "redo step work list",
        "change the request config: {&quot;platforms&quot;:[&quot;linux64/debug&quot;]}",
        "run in /build/worktrees/spinner: git stash list",
      ],
    );
    assert.equal(labels[7][1], "run in <code>/build/worktrees/spinner</code>: <code>git stash list</code>");
    assert.match(h, /<span class="reason clamp1" data-expand>Taskcluster answered 503 at 07:00; it is back up\.<\/span>/);
    const list = h.indexOf('<ul class="plan">');
    const notes = h.indexOf('<ul class="plan-notes">');
    assert.ok(list >= 0 && notes > h.indexOf("</ul>", list), "Can't do and questions come after the list");
    assert.match(h, /<span class="why clamp1" title="You said: “the browser_tabSpinner agent has been at it for 6 hours”">/);
  });

  it("4. investigate and fix: a running request-level job shows in the summary line and at the top of the body", () => {
    const h = expanded("r-20261013-tab-failures");
    const said = "restart the browser_pinnedTabs.js item, it has been waiting for a build slot since this morning";
    const work = new RegExp(
      `<div class="rwork"><div title="recover"><span class="st run">working on <span class="said" title="${said}">“${said}”</span></span> · Opus · <span data-since="2026-10-15T08:59:00.000Z">1 min</span> <form[^>]*><input type="hidden" name="command" value="${cmd({ cmd: "stop", job: "j-recover-2", request: "r-20261013-tab-failures" })}">`,
      "g",
    );
    const summary = h.indexOf("</summary>");
    const found = [...h.matchAll(work)].map((m) => m.index);
    assert.equal(found.length, 2);
    assert.ok(found[0] < summary && found[1] > h.indexOf('<div class="rbody">'));
    assert.ok(h.indexOf('data-watch="/api/requests/r-20261013-tab-failures/jobs/j-recover-2/activity"') > h.indexOf('<div class="rbody">'), "Watch only in the body");
    const collapsed = renderRequest(get("r-20261015-sessionstore"), ctx, false).value;
    assert.match(collapsed, /<div title="route-request"><span class="st run">route request<\/span> · Sonnet · <span data-since/);
    const old = structuredClone(get("r-20261013-tab-failures"));
    delete old.jobs["j-recover-2"].purpose;
    assert.match(renderRequest(old, ctx).value, /<span class="st run">recovery plan<\/span> · Opus/, "without a purpose");
  });

  it("4. investigate and fix: Stop on running jobs, Watch on agents, Continue on closed groups", () => {
    const h = expanded("r-20261013-tab-failures");
    const row = (item: string) => h.slice(h.indexOf(`<tr data-item="${item}">`), h.indexOf("</tr>", h.indexOf(`<tr data-item="${item}">`)));
    assert.ok(row("i-spinner").includes(cmd({ cmd: "stop", job: "j-inv-spinner", request: "r-20261013-tab-failures" })));
    assert.match(row("i-spinner"), /data-watch="\/api\/requests\/r-20261013-tab-failures\/jobs\/j-inv-spinner\/activity"/);
    assert.doesNotMatch(row("i-close"), /cmd&quot;:&quot;(stop|continue)/);
    const closed = structuredClone(get("r-20261013-tab-failures"));
    closed.items["i-spinner"].state = "left as-is";
    delete closed.jobs["j-inv-spinner"].endedAt;
    closed.jobs["j-inv-spinner"].endedAt = "2026-10-15T08:00:00.000Z";
    const c = renderRequest(closed, ctx, true).value;
    assert.ok(c.includes(cmd({ cmd: "continue", request: "r-20261013-tab-failures", item: "i-spinner" })));
    assert.ok(!c.includes(cmd({ cmd: "continue", request: "r-20261013-tab-failures", item: "i-mute" })), "no author session to talk to");
    const jobs = h.slice(h.indexOf('data-fold="jobs"'));
    assert.ok(jobs.includes(cmd({ cmd: "stop", job: "j-recover-2", request: "r-20261013-tab-failures" })));
    assert.ok(!jobs.includes(cmd({ cmd: "stop", job: "j-recover", request: "r-20261013-tab-failures" })), "finished jobs can't be stopped");
  });

  it("every ⚑ has a way out: accept or continue after the review limit, retry or continue a failed job, dismiss the rest", () => {
    const r = structuredClone(get("r-20261013-tab-failures"));
    const base = { kind: "agent" as const, cmd: ["node"], cwd: "/x", pid: 1, pidStartTime: 1, startedAt: "2026-10-15T08:00:00.000Z", endedAt: "2026-10-15T08:10:00.000Z", exitCode: 0 };
    r.jobs["j-review"] = { ...base, job: "j-review", name: "review-patch", item: "i-drag" };
    r.jobs["j-push"] = { ...base, kind: "script", job: "j-push", name: "try.ts push", purpose: { key: "push:A", what: "push", push: "A" }, exitCode: 1 };
    r.needsUser = [
      { key: "failed:j-review", action: "No ok after 3 critical review rounds", detail: "still racy", job: "j-review", item: "i-drag", since: r.createdAt },
      { key: "failed:j-artifacts", action: "artifacts.ts fetch failed twice", detail: "503", job: "j-artifacts", item: "i-drag", since: r.createdAt },
      { key: "failed:j-push", action: "try.ts push failed (not retried: it may have happened)", detail: "lando", job: "j-push", since: r.createdAt },
      { key: "stopped:j-inv-spinner", action: "investigate-and-fix stopped by you", detail: "", job: "j-inv-spinner", item: "i-spinner", since: r.createdAt },
      { key: "note:x", action: "Something to know", detail: "", since: r.createdAt },
    ];
    const h = renderRequest(r, ctx).value;
    const flag = (key: string) => h.slice(h.indexOf(`data-key="${key}"`), h.indexOf("</div>", h.indexOf(`data-key="${key}"`)));
    const R = "r-20261013-tab-failures";
    assert.ok(flag("failed:j-review").includes(cmd({ cmd: "accept-review", item: "i-drag", request: R })));
    assert.match(flag("failed:j-review"), />Accept as reviewed</);
    assert.ok(flag("failed:j-review").includes(cmd({ cmd: "continue", request: R, item: "i-drag" })));
    assert.doesNotMatch(flag("failed:j-review"), />Retry</);
    assert.ok(flag("failed:j-artifacts").includes(cmd({ cmd: "retry", job: "j-artifacts", request: R })));
    assert.ok(flag("failed:j-artifacts").includes(cmd({ cmd: "continue", request: R, item: "i-drag" })));
    assert.doesNotMatch(flag("failed:j-push"), />Retry</, "try pushes aren't retried");
    assert.ok(flag("failed:j-push").includes(cmd({ cmd: "dismiss", key: "failed:j-push", request: R })));
    assert.ok(flag("stopped:j-inv-spinner").includes(cmd({ cmd: "continue", request: R, item: "i-spinner" })));
    assert.ok(flag("note:x").includes(cmd({ cmd: "dismiss", key: "note:x", request: R })));
  });

  it("a patch whose critical review hasn't passed is a draft on its group row, without a bug to file", () => {
    const r = structuredClone(get("r-20261013-tab-failures"));
    r.patches["p-drag"] = {
      id: "p-drag",
      item: "i-drag",
      sha: "d".repeat(40),
      worktree: "/build/worktrees/drag",
      title: "Bug XXXXXXX - Close the drag session on failure, r=dao.",
      bug: null,
      bugDraft: { product: "Firefox", component: "Tabbed Browser", summary: "Drag session left open", description: "d" },
      deps: [],
      replyDrafts: [],
    };
    const h = renderRequest(r, ctx, true).value;
    assert.doesNotMatch(h, /data-patch="p-drag"/);
    assert.match(h, /data-patch="p-close"/, "reviewed patches stay in the Patches section");
    const row = h.slice(h.indexOf('<tr data-item="i-drag">'), h.indexOf("</tr>", h.indexOf('<tr data-item="i-drag">')));
    assert.match(row, /<div class="sub">draft · review findings · “Close the drag session on failure, r=dao\.”<\/div>/);
    assert.doesNotMatch(h, /Drag\+session\+left\+open/, "no Bug to file link");
    assert.match(h, /<span class="rsum">[^<]*· 1 patch<\/span>/);
    r.items["i-drag"].state = "blocked";
    assert.doesNotMatch(renderRequest(r, ctx, true).value, /data-patch="p-drag"/, "blocked after the review limit: still a draft");
    r.items["i-drag"].state = "reviewed";
    const reviewed = renderRequest(r, ctx, true).value;
    assert.match(reviewed, /data-patch="p-drag"/);
    assert.match(reviewed, /Drag\+session\+left\+open/);
    assert.match(reviewed, /<span class="rsum">[^<]*· 2 patches, 1 bug to file<\/span>/);
  });

  it("shows a refused command as a ⚑ you can dismiss", () => {
    const r = structuredClone(get("r-20261013-tab-failures"));
    r.needsUser = [];
    r.refused = [{ key: "refused:c-7", command: "c-7", cmd: "start-agent", detail: "start-agent only starts a new investigate-and-fix on an item that already had one", t: r.createdAt }];
    const h = renderRequest(r, ctx).value;
    assert.match(h, /<details class="req needs"/);
    assert.match(h, /<span class="flag">Your restart of the investigation was refused<\/span> <span class="why">start-agent only starts a new investigate-and-fix on an item that already had one<\/span>/);
    assert.ok(h.includes(cmd({ cmd: "dismiss", key: "refused:c-7", request: "r-20261013-tab-failures" })));
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
    assert.match(h, /<span class="bug none">no bug yet<\/span> Save the prefs file of test_libPrefs\.js in the temp dir, r=gstoll\. <span class="sub">\(meta bug\)<\/span>/);
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

describe("a burndown with closed groups, running agents and a dropped patch", () => {
  const ID = "r-20261015-enterprisepolicies";
  const h = expanded(ID);
  const section = (from: string, to: string) => h.slice(h.indexOf(from), h.indexOf(to, h.indexOf(from)));

  it("shows only the config fields that have a value, in words, and no config block when none has", () => {
    assert.match(h, /<b>folders<\/b>: browser\/components\/enterprisepolicies\/tests\/browser<\/div>/);
    assert.doesNotMatch(h, /<b>tests<\/b>|\[\]/);
    const r = structuredClone(get(ID));
    r.config = { folders: [], tests: [], platforms: [], constraints: [] };
    assert.doesNotMatch(renderRequest(r, ctx, true).value, /Config/);
  });

  it("lists the patch of a left-as-is group as dropped, without a bug number, and doesn't count it", () => {
    assert.doesNotMatch(h, /Bug 0/);
    assert.doesNotMatch(h, /data-patch=/);
    assert.match(h, /<details class="fold" data-fold="dropped-loose"><summary>Dropped \(1\)<\/summary><div class="sub"><span class="bug none">no bug yet<\/span> Convert scoping skip-if/);
    assert.match(h, /<span class="rsum">7 failure groups: 1 not started, 2 investigating, 4 left as-is<\/span>/);
    assert.doesNotMatch(h, /<h3>Patches<\/h3>/, "no heading over dropped patches alone");
  });

  it("names tests relative to the request's folder, with the full path and message in tooltips", () => {
    assert.match(h, /<span title="browser\/components\/enterprisepolicies\/tests\/browser\/trackingprotection\/browser_policy_trackingprotection\.js\n[^"]*">trackingprotection\/browser_policy_trackingprotection\.js<\/span>/);
    assert.match(h, />browser_policy_sitepolicies_jit\.js<\/span>/);
    assert.match(h, /<div class="sub clamp2" title="leaked 1 window\(s\) until shutdown \[url = about:preferences#etp\]">/);
  });

  it("shows running work in the group rows, with the group's cost so far", () => {
    assert.match(h, /investigating<\/span><span class="sub"> · Opus · <span data-since="2026-10-15T08:53:00.000Z">7 min<\/span> · <span title="Agent cost of this group so far">\$0\.40<\/span><\/span>/);
    assert.match(h, /investigating<\/span><span class="sub"> · Opus · <span data-since="2026-10-15T08:54:00.000Z">6 min<\/span><\/span>/);
    assert.match(h, /<span class="st run">preparing<\/span><span class="sub"> · build worktree · <span data-since/);
  });

  it("puts the running groups first, then the others, and folds the closed ones with their full reasons", () => {
    const at = (item: string) => h.indexOf(`data-item="${item}"`);
    const fold = h.indexOf('<details class="fold" data-fold="closed-groups"><summary>3 left as-is</summary>');
    assert.ok(fold > 0);
    assert.ok(at("i-browser-policy-trackingprotection") < fold);
    for (const closed of ["i-annotations", "i-browser-policy-firefoxhome", "i-browser-policy-firefoxhome-2"]) {
      assert.ok(at(closed) > fold, closed);
    }
    assert.match(h, /<details class="clamp3" data-fold="detail-i-annotations" title="left as-is: Dropped the run-if commit per review;[^"]*nothing left to convert and the DEBUG un-skip push showed no failures to fix\."><summary><span class="st closed">left as-is<\/span><span class="detail">: Dropped/);

    const r = structuredClone(get(ID));
    r.jobs["j-wt-sw2"].endedAt = "2026-10-15T09:00:00.000Z";
    r.items["i-browser-policy-firefoxhome"].state = "handed back";
    const h2 = renderRequest(r, ctx, true).value;
    assert.ok(h2.indexOf('data-item="i-browser-policy-trackingprotection"') < h2.indexOf('data-item="i-browser-policy-sitepolicies-serviceworke-2"'), "not started after running");
    assert.match(h2, /<summary>3 closed<\/summary>/);
  });

  it("shows the Bug to file link of a group whose report drafted a bug without a patch", () => {
    const row = section('data-item="i-browser-policy-sitepolicies-jit"', "</tr>");
    assert.match(row, /<a class="bug tofile" href="https:\/\/bugzilla\.mozilla\.org\/enter_bug\.cgi\?product=Firefox&amp;component=Enterprise\+Policies&amp;short_desc=Workers\+start\+slowly/);
    assert.match(row, /<span class="sub">“Workers start slowly when a site policy disables the JIT”<\/span>/);
    const r = structuredClone(get(ID));
    r.patches["p-runif"].item = "i-browser-policy-sitepolicies-jit";
    assert.doesNotMatch(renderRequest(r, ctx, true).value, /Workers start slowly/, "a patch's draft shows on the patch row");
  });

  it("keeps a closed group with a bug to file out of the fold, without asking you for it", () => {
    assert.ok(h.indexOf('data-item="i-browser-policy-sitepolicies-jit"') < h.indexOf('data-fold="closed-groups"'));
    assert.doesNotMatch(h, /to file<\/span>|bug to file/);
    assert.doesNotMatch(h, /class="action"/);
  });

  it("lists the file names of a small group, and the item id of a job whose item is unknown", () => {
    assert.match(h, /">browser_policy_managedbookmarks\.js, browser_policy_search_engine\.js<\/span>/);
    const r = structuredClone(get(ID));
    r.jobs["j-inv-tp"].item = "i-gone";
    assert.match(renderRequest(r, ctx, true).value, /<span class="sub" title="i-gone">i-gone<\/span>/);
  });

  it("folds recent jobs, with job labels and test names", () => {
    const jobs = section('<details class="fold section" data-fold="jobs">', "</details>");
    assert.ok(jobs.length > 0);
    assert.match(jobs, /<span title="worktree\.ts create">build worktree<\/span> <span class="sub" title="i-browser-policy-sitepolicies-serviceworke-2">browser_policy_sitepolicies_serviceworkers\.js<\/span>/);
    assert.match(jobs, /<span title="investigate-and-fix">investigate<\/span> <span class="sub" title="i-browser-policy-trackingprotection">trackingprotection\/browser_policy_trackingprotection\.js/);
    assert.doesNotMatch(jobs, />i-browser/);
  });

  it("hides the Effort and Value columns while no patch has one", () => {
    assert.match(expanded("r-20261013-tab-failures"), /<th class="hide-sm"[^>]*>Effort<\/th><th class="num hide-sm"[^>]*>Value<\/th>/);
    const r = structuredClone(get("r-20261013-tab-failures"));
    delete r.patches["p-close"].effort;
    delete r.items["i-close"].group.ratePerWeek;
    const t = renderRequest(r, ctx, true).value;
    assert.doesNotMatch(t, /Effort|Value/);
    assert.match(t, /<th>Patch<\/th><th>State<\/th><\/tr>/);
  });

  it("labels jobs by what they do", () => {
    assert.equal(jobLabel("worktree.ts create --build artifact"), "build worktree");
    assert.equal(jobLabel("lint-text.ts commit"), "lint message");
    assert.equal(jobLabel("failures.ts collect"), "collect failures");
    assert.equal(jobLabel("review-patch"), "critical review");
    assert.equal(jobLabel("draft-reply"), "draft-reply");
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
