import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { FixtureStateSource } from "../state-source.ts";
import type { RequestState } from "../../types.ts";
import { jobLabel, pushStatus, type RenderContext } from "./common.ts";
import { renderOverview, renderRecentPushes } from "./overview.ts";
import { IDLE, itemBucket, runningSentence } from "./progress.ts";
import { configTable, parseConfig, renderRequest } from "./request.ts";
import { conversationOf, renderActivity } from "./activity.ts";
import { ITEM_STATES } from "../commands.ts";

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

// The row of a group (item-<id>) or patch (patch-<id>), up to the next row.
function rowOf(h: string, id: string): string {
  const start = h.indexOf(`<details class="row" id="${id}"`);
  assert.ok(start >= 0, id);
  const next = h.indexOf('<details class="row"', start + 1);
  return h.slice(start, next < 0 ? undefined : next);
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

  it("shows one line per active request with its cost and Profile button", () => {
    assert.equal((page.match(/<details class="req/g) ?? []).length, 11);
    assert.doesNotMatch(page, /class="step"/, "no internal step names");
    assert.match(page, /\$[\d.]+ spent/);
    const url = encodeURIComponent("http://factory:4300/api/requests/r-20261005-newtab/profile");
    assert.ok(page.includes(`href="http://localhost:4242/from-url/${url}?thread=0"`));
  });

  it("has the header strip and the global Tell the factory box", () => {
    assert.match(page, /agents <b>10\/10<\/b>/);
    assert.match(page, /<span class="progress"><span class="pbar">(<span class="[a-z-]+" style="flex-grow:\d+"><\/span>){5}<\/span><span class="needs-you">19 need you<\/span> · <span class="working">8 working<\/span> · <span class="ready">14 ready<\/span> · <span class="pending">3 pending<\/span> · <span class="closed">6 closed<\/span><\/span>/);
    assert.ok(page.includes(cmd({ cmd: "tell-factory" })));
    assert.doesNotMatch(page, /New request|new-request/);
    assert.match(page, /<link rel="icon" href="data:image\/svg\+xml,[^"]*🏭/);
  });
  it("archives text from the main box that was forwarded, or rephrased after it couldn't be routed, with what became of it", () => {
    assert.ok(page.indexOf("r-20261015-lando-was-down-re-push") > page.indexOf("<h2>Finished"));
    assert.match(page, /<b>Lando was down this morning, re-push what failed<\/b> <span class="sub">· Forwarded to r-20261013-tab-failures<\/span>/);
    assert.ok(page.indexOf("r-20261015-hmm") > page.indexOf("<h2>Finished"));
    assert.match(page, /<b>hmm<\/b> <span class="sub">· Superseded by r-20261015-sessionstore<\/span>/);
  });

  it("lists the try pushes still running across requests, each linked to its row in its request", () => {
    const h = renderRecentPushes(source.listRequests())?.value ?? "";
    const running = source.listRequests().flatMap((r) => Object.values(r.pushes).filter((p) => p.rev && p.result === undefined).map((p) => ({ r, p })));
    const done = source.listRequests().flatMap((r) => Object.values(r.pushes).filter((p) => p.rev && p.result !== undefined));
    assert.ok(running.length > 0 && done.length > 0, "the fixtures have both");
    for (const { r, p } of running) assert.ok(h.includes(`href="/requests/${r.id}#push-${p.id}"`), p.id);
    for (const p of done) assert.ok(!h.includes(`>${p.rev!.slice(0, 12)}<`), p.id);
    assert.match(h, /<h2>On try now<\/h2>/);
  });

  it("renders collapsed requests without their body", () => {
    assert.doesNotMatch(page, /class="rbody">/);
    assert.match(page, /data-lazy/);
  });
});

describe("one fixture per step of docs/MVP.md", () => {
  it("1. request: text from the main box, titled by its text, while route-request runs", () => {
    const h = expanded("r-20261015-sessionstore");
    assert.match(h, /<span class="rname">Burn down browser\/components\/sessionstore\/test, skip the mac pools for now<\/span>/);
    assert.match(h, /not routed yet/);
    assert.match(h, /<span class="res run">route request<\/span>/);
    assert.match(h, /<span class="rsum"><span class="rprog"><span class="sub">nothing to work on yet<\/span><\/span> · not routed yet: a new request, or about an existing one\? · route request<\/span>/, "its own job isn't a group");
  });
  it("2. first signal: approve or decline the un-skip push on its row, its jobs, command and try_task_config under it", () => {
    const h = expanded("r-20261014-extensions-xpcshell");
    assert.match(h, /From your request: .*<b>platforms<\/b>: linux, windows/);
    const header = h.slice(0, h.indexOf("</summary>"));
    assert.doesNotMatch(header, /approve-push/, "not in the header: on its row");
    const row = rowOf(h, "push-unskip");
    assert.match(row, /<span class="state">waiting for your approval<\/span>/);
    const top = row.slice(0, row.indexOf("</summary>"));
    assert.ok(top.includes(cmd({ cmd: "approve-push", request: "r-20261014-extensions-xpcshell", push: "unskip" })), "Approve on its top line");
    assert.ok(top.includes(cmd({ cmd: "decline-push", request: "r-20261014-extensions-xpcshell", push: "unskip", text: "discarded" })), "🗑 on its top line");
    assert.match(top, /aria-label="Discard">🗑<\/button>/);
    assert.match(top, /data-revise[^>]*>Revise…<\/button>/);
    const body = row.slice(row.indexOf("</summary>"));
    assert.ok(body.includes(cmd({ cmd: "revise-push", request: "r-20261014-extensions-xpcshell", push: "unskip" })), "the revise box in its body");
    assert.match(body, /<form class="cmd revise"[^]*<textarea name="text" required[^>]*><\/textarea><button class="btn small">Revise<\/button><\/form>/);
    assert.match(row, /data-tasks="\/api\/requests\/r-20261014-extensions-xpcshell\/pushes\/unskip\/tasks"/);
    assert.match(top, /<span>186 tasks<\/span>/);
    assert.match(row, /<div class="ptasks">Loading…<\/div>/);
    assert.doesNotMatch(row, /pushjobs-unskip/, "not folded while it waits for you");

  });

  it("6. verify on try: a group on try is working, not ready, until its push has results", () => {
    const r = structuredClone(source.getRequest("r-20261010-xpcshell-cwd")!);
    const i = Object.values(r.items)[0];
    r.needsUser = r.needsUser.filter((n) => n.item !== i.id);
    i.state = "in try";
    assert.equal(itemBucket(r, i, ctx), "working");
  });

  it("2. first signal: Revise, while it waits and on a push you declined; not once discarded-and-revised, withdrawn or revised", () => {
    const R = "r-20261014-extensions-xpcshell";
    const r = structuredClone(source.getRequest(R)!);
    r.needsUser = r.needsUser.filter((n) => n.key !== "approve-push:unskip");
    r.pushes.unskip.declined = "on mac";
    let row = rowOf(renderRequest(r, ctx, true).value, "push-unskip");
    assert.match(row, /<span class="state">you declined it: on mac<\/span>/);
    assert.match(row, /data-revise[^>]*>Revise…<\/button>/);
    assert.match(row, /<textarea name="text"[^>]*>on mac<\/textarea>/, "prefilled with what you wrote");
    assert.doesNotMatch(row, /Discard/, "no longer waiting");
    r.pushes.unskip.declined = "discarded";
    row = rowOf(renderRequest(r, ctx, true).value, "push-unskip");
    assert.match(row, /<span class="state">you discarded it<\/span>/);
    assert.match(row, /<textarea name="text"[^>]*><\/textarea>/, "not prefilled with “discarded”");
    r.pushes.unskip.declined = "on mac";
    r.pushes.unskip.replan = true;
    row = rowOf(renderRequest(r, ctx, true).value, "push-unskip");
    assert.match(row, /<span class="state">you asked for a revision: on mac<\/span>/);
    assert.doesNotMatch(row, /revise-push|Revise…/);
    r.pushes.unskip.replan = undefined;
    r.pushes.unskip.withdrawn = true;
    assert.doesNotMatch(rowOf(renderRequest(r, ctx, true).value, "push-unskip"), /revise-push|Revise…/);
  });

  it("2. first signal: an approved push says it's pushing on its row, not above the pushes", () => {
    const r = structuredClone(source.getRequest("r-20261014-extensions-xpcshell")!);
    r.needsUser = r.needsUser.filter((n) => n.key !== "approve-push:unskip");
    r.jobs["j-push"] = { job: "j-push", kind: "cli", name: "try.ts push", purpose: { key: "push:unskip", what: "push", push: "unskip" }, startedAt: "2026-10-15T08:59:00.000Z" } as unknown as RequestState["jobs"][string];
    const h = renderRequest(r, ctx, true).value;
    const row = rowOf(h, "push-unskip");
    assert.match(row, /<span class="state">approved, pushing for <span data-since/);
    assert.doesNotMatch(row, /approve-push|Revise…|Discard/);
    assert.doesNotMatch(h.slice(0, h.indexOf("Try pushes")), /push to try/, "its job is on its row");
  });

  it("3. work list: take it or hand it back", () => {
    const h = expanded("r-20261013-dom-indexeddb");
    assert.ok(h.includes(cmd({ cmd: "take-it", request: "r-20261013-dom-indexeddb", item: "i-idb-quota" })));
    assert.ok(h.includes(cmd({ cmd: "hand-back", request: "r-20261013-dom-indexeddb", item: "i-idb-quota" })));
    assert.match(h, />Fix it anyway</);
    assert.match(h, />Leave it to them</);
  });

  it("4. investigate and fix: item states, running agent, recovery plan with a checkbox per command", () => {
    const h = expanded("r-20261013-tab-failures");
    assert.match(rowOf(h, "item-i-spinner"), /<span class="st run"><\/span>[^]*<span class="state"><span class="working">investigating · <span data-since="[^"]+">6 h<\/span><\/span><\/span>/);
    assert.match(rowOf(h, "item-i-drag"), /<span class="st find"><\/span>[^]*<span class="state">stalled: nothing running: the drag session is still left open on failure<\/span>/);
    assert.match(rowOf(h, "item-i-mute"), /<span class="st closed"><\/span>[^]*<span class="state">closed: handed back to you: bug 2081413, dao active<\/span>/);
    assert.match(rowOf(h, "item-i-pin"), /<span class="state">waiting for a build slot \(0 builds running\)<\/span>/);
    assert.doesNotMatch(h, /<span class="state">(review findings|handed back|investigating)</, "no state names");
    const boxes = h.match(/<input type="checkbox" name="command"[^>]*>/g) ?? [];
    assert.equal(boxes.length, 8);
    assert.match(boxes[0], / checked>$/);
    assert.doesNotMatch(boxes[7], /checked/, "shell commands are opt-in");
    assert.match(h, /Run checked/);
    assert.ok(h.includes(cmd({ cmd: "reply-recovery", request: "r-20261013-tab-failures", job: "j-recover" })));
    assert.match(h, /Can't do: Read the profile/);
    assert.match(h, /Should the next attempt use a debug build\?/);
  });
  it("4. investigate and fix: one plain-words line per planned command, its reason under it, notes after the list", () => {
    const h = expanded("r-20261013-tab-failures");
    const labels = [...h.matchAll(/<li><label title="([^"]*)"><input type="checkbox"[^>]*> (.*?)<\/label><span class="reason">/g)].map((m) => [m[1], m[2]]);
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
    assert.match(h, /<span class="reason">Taskcluster answered 503 at 07:00; it is back up\.<\/span>/);
    const list = h.indexOf('<ul class="plan">');
    const notes = h.indexOf('<ul class="plan-notes">');
    assert.ok(list >= 0 && notes > h.indexOf("</ul>", list), "Can't do and questions come after the list");
    assert.match(h, /<span class="why clamp1" title="You said: “the browser_tabSpinner agent has been at it for 6 hours”">/);
  });

  it("4. investigate and fix: a running request-level job is named in the summary line, not counted with the groups, and shown at the top of the body", () => {
    const h = expanded("r-20261013-tab-failures");
    const said = "restart the browser_pinnedTabs.js item, it has been waiting for a build slot since this morning";
    const summary = h.slice(0, h.indexOf("</summary>"));
    assert.match(summary, /<span class="needs-you">2 need you<\/span> · <span class="working">1 working<\/span> · <span class="ready">1 ready<\/span> · <span class="pending">1 pending<\/span> · <span class="closed">1 closed<\/span><\/span> · recovery plan<\/span>/);
    const body = h.slice(h.indexOf('<div class="rbody">'));
    assert.ok(
      body.startsWith(
        `<div class="rbody">\n    <div class="jobs"><details class="job" data-fold="job-j-recover-2" data-watch="/api/requests/r-20261013-tab-failures/jobs/j-recover-2/activity" data-live><summary><span class="res run">working on <span class="said" title="${said}">“${said}”</span></span> <span class="sub">Opus · running <span data-since="2026-10-15T08:59:00.000Z">1 min</span></span> <form`,
      ),
    );
    assert.ok(body.includes(cmd({ cmd: "stop", job: "j-recover-2", request: "r-20261013-tab-failures" })));
    const old = structuredClone(get("r-20261013-tab-failures"));
    delete old.jobs["j-recover-2"].purpose;
    assert.match(renderRequest(old, ctx, true).value, /<span class="res run">recovery plan<\/span>/, "without a purpose");
  });
  it("4. investigate and fix: a group's jobs under it, Stop on the running ones, an agent's opening on its activity, Reopen on closed groups", () => {
    const h = expanded("r-20261013-tab-failures");
    assert.ok(rowOf(h, "item-i-spinner").includes(cmd({ cmd: "stop", job: "j-inv-spinner", request: "r-20261013-tab-failures" })));
    assert.match(rowOf(h, "item-i-spinner"), /<details class="job" data-fold="job-j-inv-spinner" data-watch="\/api\/requests\/r-20261013-tab-failures\/jobs\/j-inv-spinner\/activity" data-live><summary><span class="res run">investigating<\/span>/);
    assert.doesNotMatch(rowOf(h, "item-i-mute"), /cmd&quot;:&quot;(stop|continue)/);
    const closed = structuredClone(get("r-20261013-tab-failures"));
    closed.items["i-spinner"].state = "left as-is";
    closed.jobs["j-inv-spinner"].endedAt = "2026-10-15T08:00:00.000Z";
    const c = renderRequest(closed, ctx, true).value;
    assert.match(rowOf(c, "item-i-spinner"), /<summary class="btn small">Reopen…<\/summary>/);
    assert.ok(rowOf(c, "item-i-spinner").includes(cmd({ cmd: "continue", request: "r-20261013-tab-failures", item: "i-spinner" })));
    assert.ok(!c.includes(cmd({ cmd: "continue", request: "r-20261013-tab-failures", item: "i-mute" })), "no author session to talk to");
    const jobs = h.slice(h.indexOf('data-fold="jobs"'));
    assert.match(jobs, /<span class="res ok">recovery plan<\/span> <span class="sub">Opus · 4 min · \$0\.88<\/span>/);
    assert.ok(!jobs.includes(cmd({ cmd: "stop", job: "j-recover", request: "r-20261013-tab-failures" })), "finished jobs can't be stopped");
  });
  it("every ⚑ has a way out: accept after the review limit, retry a failed or stopped job, continue with its author, dismiss the rest", () => {
    const D = "r-20261015-downloads-stuck";
    const h = expanded(D);
    const header = h.slice(0, h.indexOf("</summary>"));
    // A group's ⚑ is on its row, the request's own ones in the header.
    const flag = (key: string) => {
      const at = header.indexOf(`data-key="${key}"`);
      return at >= 0 ? header.slice(at, header.indexOf("</div>", at)) : "";
    };
    const has = (where: string, c: object) => where.includes(cmd(c));
    for (const key of ["failed:j-review-race", "failed:j-fetch", "stopped:j-author-slow"]) {
      assert.equal(flag(key), "", `${key} is on its group's row`);
    }
    const race = rowOf(h, "item-i-race");
    assert.ok(has(race, { cmd: "accept-review", item: "i-race", request: D }));
    assert.ok(has(race, { cmd: "continue", request: D, item: "i-race" }));
    assert.doesNotMatch(race, />(Retry|Dismiss)</);
    const fetch = rowOf(h, "item-i-fetch");
    assert.ok(has(fetch, { cmd: "retry", job: "j-fetch", request: D }));
    assert.ok(has(fetch, { cmd: "continue", request: D, item: "i-fetch" }));
    assert.doesNotMatch(fetch, />(Accept the patch as it is|Dismiss)</);
    assert.match(fetch, /<span class="state">needs you: fetch test artifacts failed twice<\/span>/);
    assert.match(fetch, /title="Runs fetch test artifacts again">Retry</);
    assert.ok(has(fetch, { cmd: "hand-back", item: "i-fetch", request: D }));
    const slow = rowOf(h, "item-i-slow");
    assert.match(slow, /<span class="state">needs you: the investigation stopped by you<\/span>/);
    assert.match(slow, /<div class="ask-you"><p>You stopped the investigation\. Resume it, tell its author what to do instead, or dismiss this\.<\/p>/);
    assert.match(slow, /title="Its author continues where it stopped">Resume</);
    for (const c of [{ cmd: "retry", job: "j-author-slow", request: D }, { cmd: "continue", request: D, item: "i-slow" }, { cmd: "dismiss", key: "stopped:j-author-slow", request: D }]) {
      assert.ok(has(slow, c), JSON.stringify(c));
    }
    assert.match(flag("stopped:j-plan"), /<span class="flag">Plan try pushes stopped by you<\/span>/);
    assert.ok(has(flag("stopped:j-plan"), { cmd: "retry", job: "j-plan", request: D }));
    assert.ok(has(flag("stopped:j-plan"), { cmd: "dismiss", key: "stopped:j-plan", request: D }));
    assert.doesNotMatch(flag("stopped:j-plan"), /Continue/);
    assert.match(flag("refused:c-12"), /Your comment on the fix was refused<\/span><form[^]*?<\/form><span class="why clamp1" data-expand title="[^"]*">the author of i-nits is running/);
    assert.ok(has(flag("refused:c-12"), { cmd: "dismiss", key: "refused:c-12", request: D }));

    const r = structuredClone(get(D));
    r.jobs["j-push"] = { ...r.jobs["j-fetch"], job: "j-push", item: undefined, name: "try.ts push", purpose: { key: "push:A", what: "push", push: "A" } };
    r.needsUser = [
      { key: "failed:j-push", action: "try.ts push failed (not retried: it may have happened)", detail: "lando", job: "j-push", since: r.createdAt },
      { key: "approve-push:A", action: "Approve try push A", detail: "", since: r.createdAt },
      { key: "note:x", action: "Something to know", detail: "", since: r.createdAt },
    ];
    const h2 = renderRequest(r, ctx).value;
    const flag2 = (key: string) => h2.slice(h2.indexOf(`data-key="${key}"`), h2.indexOf("</div>", h2.indexOf(`data-key="${key}"`)));
    assert.doesNotMatch(flag2("failed:j-push"), />Retry</, "try pushes aren't retried");
    assert.ok(flag2("failed:j-push").includes(cmd({ cmd: "dismiss", key: "failed:j-push", request: D })));
    assert.doesNotMatch(flag2("approve-push:A"), /Dismiss/, "dismissing it would approve the push");
    assert.ok(flag2("note:x").includes(cmd({ cmd: "dismiss", key: "note:x", request: D })));
  });
  it("each group row says in plain words what is happening, what is stuck and what has stalled", () => {
    const h = expanded("r-20261015-downloads-stuck");
    const state = (item: string, html = h) => /<span class="state">(.*?)<\/span><\/summary>/.exec(rowOf(html, `item-${item}`))?.[1];
    assert.equal(state("i-race"), "needs you: critical reviews didn&#39;t pass");
    assert.match(rowOf(h, "item-i-race"), /<\/details><div class="ask-you"><p>Its critical reviews still find problems[^<]*<\/p><ul class="findings"><li>[^<]+<\/li>/, "the question in sight, without opening the row");
    assert.match(rowOf(h, "item-i-race"), /<span class="st find"><\/span>/);
    assert.match(rowOf(h, "item-i-race"), />Accept the patch as it is</);
    assert.equal(state("i-idle"), "stalled: nothing running");
    assert.match(rowOf(h, "item-i-idle"), /title="Resumes its author's session with your message; its patch then goes through lint and critical review again">Send to its author</);
    assert.ok(rowOf(h, "item-i-idle").includes(cmd({ cmd: "continue", request: "r-20261015-downloads-stuck", item: "i-idle" })));
    const r = structuredClone(get("r-20261015-downloads-stuck"));
    const atCap = renderRequest(r, { ...ctx, runningAgents: 10, maxAgents: 10 }, true).value;
    assert.equal(state("i-idle", atCap), "waiting for an agent (10/10 running)", "not stalled: waiting for a slot");
    r.jobs["j-lint-idle"] = { ...r.jobs["j-fetch"], job: "j-lint-idle", item: "i-idle", name: "lint-text.ts commit", error: "cancelled by you", exitCode: -1 };
    r.items["i-idle"].jobs.push("j-lint-idle");
    const stopped = renderRequest(r, ctx, true).value;
    assert.equal(state("i-idle", stopped), "stalled after you stopped its lint message");
    assert.match(rowOf(stopped, "item-i-idle"), /title="Runs lint message again">Retry</);
    assert.match(state("i-nits")!, /^<span class="working">author addressing review nits · <span data-since="2026-10-15T08:58:00.000Z">2 min<\/span><\/span>$/);
    assert.match(rowOf(h, "item-i-review"), /<span class="state"><span class="working">being reviewed by Opus · <span data-since="2026-10-15T08:59:00.000Z">1 min<\/span><\/span><\/span>/);
    assert.equal(state("i-wait"), "waiting for a build slot (0 builds running)");
    assert.equal(state("i-done"), "closed: already fixed by bug 2078564");
    assert.match(h, /<span class="rprog"><span class="pbar">.*?<\/span><span class="needs-you">6 need you<\/span> · <span class="working">2 working<\/span>/);
  });
  it("asks to retry a crashed reviewer, not to resume its author; and shows every ⚑ of a group, each with its answers", () => {
    const D = "r-20261015-downloads-stuck";
    const r = structuredClone(get(D));
    r.jobs["j-rev-idle"] = { ...r.jobs["j-review-race"], job: "j-rev-idle", item: "i-idle", exitCode: 1, endedAt: "2026-10-15T08:00:00.000Z" };
    r.items["i-idle"].jobs.push("j-rev-idle");
    r.needsUser.push(
      { key: "failed:j-rev-idle", action: "review-patch failed", detail: "API error", job: "j-rev-idle", item: "i-idle", since: r.createdAt },
      { key: "note:odd", action: "Something odd", detail: "look at it", item: "i-idle", since: r.createdAt },
    );
    const row = rowOf(renderRequest(r, ctx, true).value, "item-i-idle");
    const ask = row.slice(row.indexOf('<div class="ask-you">'));
    assert.match(ask, /^<div class="ask-you"><p>Critical review failed: API error<\/p><p>Retry it, or hand the group back to you\.<\/p>/);
    assert.match(ask, /title="Runs critical review again">Retry</);
    assert.doesNotMatch(ask, /Its author|Resume/);
    assert.ok(!ask.includes(cmd({ cmd: "continue", request: D, item: "i-idle" })), "its author has nothing to do with it");
    assert.ok(ask.includes(cmd({ cmd: "hand-back", item: "i-idle", request: D })));
    assert.match(ask, /<div class="ask-more" data-key="note:odd"><p><b>Also: Something odd<\/b><\/p><p>look at it<\/p><p>Fix it anyway, or leave it to them[^<]*<\/p><div class="jobctl"><form[^]*?>Fix it anyway<\/button>/, "the second ⚑ with its own buttons");
  });

  it("asks a flagged group's question once when it has two patches", () => {
    const T = "r-20261013-tab-failures";
    const r = structuredClone(get(T));
    r.patches["p-close2"] = { ...r.patches["p-close"], id: "p-close2", sha: "e".repeat(40) };
    r.needsUser.push({ key: "note:close", action: "Something odd", detail: "look at it", item: "i-close", since: r.createdAt });
    const h = renderRequest(r, ctx, true).value;
    assert.match(rowOf(h, "patch-p-close"), /<div class="ask-you"><p>look at it<\/p>/);
    assert.doesNotMatch(rowOf(h, "patch-p-close2"), /ask-you/);
  });

  it("asks you when its author disagrees with your message, with Tell it again, Go ahead and Hand back", () => {
    const D = "r-20261015-downloads-stuck";
    const r = structuredClone(get(D));
    r.needsUser.push({ key: "disagrees:j-author-nits", action: "Its author disagrees with you", detail: "there is no product leak", job: "j-author-nits", item: "i-nits", since: r.createdAt });
    r.jobs["j-author-nits"].endedAt = "2026-10-15T08:59:00.000Z";
    const row = rowOf(renderRequest(r, ctx, true).value, "item-i-nits");
    assert.match(row, /<span class="state">needs you: Its author disagrees with you<\/span>/);
    assert.match(row, /<p>Its author didn't do what you asked: there is no product leak<\/p>/);
    assert.ok(row.includes(cmd({ cmd: "dismiss", key: "disagrees:j-author-nits", request: D })));
    assert.ok(row.includes(cmd({ cmd: "hand-back", item: "i-nits", request: D })));
    assert.match(row, />Go ahead with its patch</);
  });

  it("maps every state, with nothing running, to a sentence: stalled when something should run", () => {
    const i = structuredClone(get("r-20261015-downloads-stuck").items["i-done"]);
    const shouldRun = ITEM_STATES.filter((s) => IDLE[s].active);
    assert.deepEqual(shouldRun, ["investigating", "fix verified locally", "in critical review", "review findings", "addressing review comments", "blocked"]);
    for (const s of ITEM_STATES.filter((x) => !IDLE[x].active)) {
      assert.doesNotMatch(IDLE[s].text({ ...i, state: s }, 2), /^(not started|in stack|in try|reviewed|left as-is|handed back)$/, s);
    }
    assert.equal(IDLE["waiting for a build slot"].text(i, 3), "waiting for a build slot (3 builds running)");
    const job = { ...get("r-20261015-downloads-stuck").jobs["j-author-nits"] };
    assert.equal(runningSentence(job), "author addressing review nits");
    assert.equal(runningSentence({ ...job, purpose: undefined }), "investigating");
    assert.equal(runningSentence({ ...job, name: "review-patch", model: "sonnet" }), "being reviewed by Sonnet");
    assert.equal(runningSentence({ ...job, name: "worktree.ts create --tests a" }), "building its worktree");
    assert.equal(runningSentence({ ...job, name: "failures.ts cluster" }), "cluster failures");
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
    assert.match(h, /data-patch="p-close"/, "a reviewed patch replaces its group's row");
    assert.doesNotMatch(h, /data-item="i-close"/);
    assert.match(rowOf(h, "item-i-drag"), /<div>Draft patch, its critical review hasn't passed yet: “Close the drag session on failure, r=dao\.” <a href="\/requests\/[^"]+\/patches\/p-drag\/view"/);
    assert.doesNotMatch(h, /Drag\+session\+left\+open/, "no Bug to file link");
    r.items["i-drag"].state = "blocked";
    assert.doesNotMatch(renderRequest(r, ctx, true).value, /data-patch="p-drag"/, "blocked after the review limit: still a draft");
    r.items["i-drag"].state = "reviewed";
    const reviewed = renderRequest(r, ctx, true).value;
    assert.match(rowOf(reviewed, "patch-p-drag"), /<span class="name" title="[^"]*"><a class="bug tofile" href="https:\/\/bugzilla\.mozilla\.org\/enter_bug\.cgi\?[^"]*Drag\+session\+left\+open[^"]*"[^>]*>Bug to file<\/a> Close the drag session/);
    assert.match(reviewed, /<span class="ready">2 ready<\/span>/);
  });
  it("names a try push named after its stack by its number", () => {
    const r = structuredClone(get("r-20261010-xpcshell-cwd"));
    r.needsUser.push({ key: "approve-push:storage-unit-a62d-3", action: "Approve try push storage-unit-a62d-3", detail: "6 tasks · why", push: "storage-unit-a62d-3", since: r.createdAt });
    assert.match(renderRequest(r, ctx).value, /<span class="flag">Approve try push 3<\/span>/);
    r.pushes["storage-unit-a62d-3"] = { ...r.pushes.A, id: "storage-unit-a62d-3" };
    r.pushes["dom-quota-b71e-3"] = { ...r.pushes.A, id: "dom-quota-b71e-3" };
    const h = renderRequest(r, ctx, true).value;
    assert.match(rowOf(h, "push-storage-unit-a62d-3"), /<span class="name" title="[^"]*">push a62d-3: /, "two stacks' pushes 3 told apart");
    assert.match(rowOf(h, "push-dom-quota-b71e-3"), /<span class="name" title="[^"]*">push b71e-3: /);
    assert.match(rowOf(h, "push-A"), /<span class="name" title="[^"]*">push A: /);
  });

  it("shows a planned push's dry-run warnings on its row, without its task count and purpose again", () => {
    const r = structuredClone(get("r-20261010-xpcshell-cwd"));
    const n = r.needsUser.find((x) => x.key === "approve-push:A")!;
    n.detail = `312 tasks · ${r.pushes.A.purpose} · --chemspill-priority is set · Large push: 312 tasks`;
    const h = renderRequest(r, ctx, true).value;
    assert.match(rowOf(h, "push-A"), /<span class="state">waiting for your approval<\/span><span class="warn">⚠ --chemspill-priority is set · Large push: 312 tasks<\/span><\/summary>/);
    assert.doesNotMatch(rowOf(h, "push-B"), /class="warn"/, "no warnings");
    r.pushes.A.purpose = "";
    n.detail = "312 tasks · chunks: xpcshell-1, xpcshell-2";
    assert.match(rowOf(renderRequest(r, ctx, true).value, "push-A"), /<span class="warn">⚠ chunks: xpcshell-1, xpcshell-2<\/span>/, "without a purpose");
  });

  it("shows a refused command as a ⚑ you can dismiss", () => {
    const r = structuredClone(get("r-20261013-tab-failures"));
    r.needsUser = [];
    r.refused = [{ key: "refused:c-7", command: "c-7", cmd: "start-agent", detail: "start-agent only starts a new investigate-and-fix on an item that already had one", t: r.createdAt }];
    const h = renderRequest(r, ctx).value;
    assert.match(h, /<details class="req needs"/);
    assert.match(h, /<span class="flag">Your restart of the investigation was refused<\/span><form[^]*?<\/form><span class="why clamp1" data-expand title="[^"]*">start-agent only starts a new investigate-and-fix on an item that already had one<\/span>/, "its title and button first, the reason under them");
    assert.ok(h.includes(cmd({ cmd: "dismiss", key: "refused:c-7", request: "r-20261013-tab-failures" })));
  });

  it("7. bugs: the patch's Bug to file link, and the paste-number/comment box hanging from it", () => {
    const h = expanded("r-20261010-xpcshell-cwd");
    const row = rowOf(h, "patch-p-copydir");
    assert.match(row, /<a class="bug tofile" href="https:\/\/bugzilla\.mozilla\.org\/enter_bug\.cgi\?product=Core&amp;component=XPCOM&amp;short_desc=CopyDirectoryTo\+leaves/);
    assert.match(row, /blocked=2081200/);
    assert.doesNotMatch(row, /assigned_to/, "no Bugzilla email configured");
    const mine = rowOf(renderRequest(source.getRequest("r-20261010-xpcshell-cwd")!, { ...ctx, bugzillaEmail: "me@mozilla.com" }, true).value, "patch-p-copydir");
    assert.match(mine, /&amp;assigned_to=me%40mozilla\.com&amp;bug_status=ASSIGNED/, "yours to attach its patch to");
    assert.match(row, /<\/summary><div class="under"><div class="box tofile">\n    <h4>Core::XPCOM · “CopyDirectoryTo leaves a read-only source directory&#39;s contents behind”/, "first in the body: clicking in it doesn't fold the row");
    assert.match(row, /<\/div><div class="lines"><span class="state">fixes <b>/, "its state under it");
    assert.ok(row.includes(cmd({ cmd: "set-bug", request: "r-20261010-xpcshell-cwd", patch: "p-copydir" })));
    assert.equal((row.match(/name="bugOrText"/g) ?? []).length, 1, "the ⚑'s buttons are the bug box");

    const r = structuredClone(source.getRequest("r-20261010-xpcshell-cwd")!);
    r.jobs["j-revise"] = { job: "j-revise", kind: "agent", name: "revise-bug-draft", purpose: { key: "revise-draft:p-copydir:c-1", what: "revise-draft", patch: "p-copydir", reason: "use `backticks`" }, startedAt: "2026-10-15T08:00:00.000Z", endedAt: "2026-10-15T08:00:06.000Z", exitCode: 0, outcome: "Which functions?" } as RequestState["jobs"][string];
    assert.match(rowOf(renderRequest(r, ctx, true).value, "patch-p-copydir"), /<div class="revisions"><div class="sub">Revised after your comment “use `backticks`” · [^<]*<div class="answer">It answered: Which functions\?<\/div>/);
  });
  it("5. stack: patches in stack order, deps, effort and value", () => {
    const h = expanded("r-20261010-xpcshell-cwd");
    const order = ["p-prefs", "p-storage", "p-copydir", "p-fixture"].map((p) => h.indexOf(`data-patch="${p}"`));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.ok(order[0] > 0);
    assert.match(h, /<span class="bug none" title="Goes under the meta bug">meta bug<\/span> Save the prefs file of test_libPrefs\.js in the temp dir, r=gstoll\./);
    assert.match(h, /⛔ hard: needs “Make nsLocalFile::CopyDirectoryTo/);
    assert.match(h, /🔗 soft: needs a newer sqlite on the try builders \(the vacuum test is slow without it\)/);
    assert.match(rowOf(h, "patch-p-prefs"), /<h4 class="part">The failure<\/h4><div class="failure">Test wrote into its own directory<\/div><div class="sub">linux64\/debug, windows11-64\/opt<\/div><div class="sub">2 configs · 31 failures\/week · <a href="https:\/\/tests\.firefox\.dev\/test\.html\?test=storage%2Ftest%2Funit%2Ftest_libPrefs\.js"[^>]*>rates on tests\.firefox\.dev ↗<\/a><\/div><h4 class="part">The fix<\/h4><div class="sub">review effort 1\/5<\/div>/);
    assert.match(h, /<div class="sub">\d+ configs? · 40 failures\/week · /);
    assert.doesNotMatch(h, /Allow one try push/);
    assert.match(h, /href="\/requests\/r-20261010-xpcshell-cwd\/stacks\/storage-unit\/review"/);
  });
  it("6. verify on try: one row per push, planned ones with Approve and Approve both, finished ones with their result", () => {
    const h = expanded("r-20261010-xpcshell-cwd");
    assert.match(rowOf(h, "push-A"), /<span class="name" title="Same configs[^"]*">push A: Same configs and paths as the un-skip push/);
    assert.match(h, /<h3>Try pushes <form[^]*?>Approve both<\/button><\/form><\/h3>/);
    const done = Object.values(get("r-20261010-xpcshell-cwd").pushes).find((p) => p.result === "failures")!;
    assert.match(rowOf(h, `push-${done.id}`), /<span class="state">291 failures, 12 groups<\/span>/);
    assert.ok(h.indexOf('id="push-A"') < h.indexOf(">storage/test/unit</span>"), "at the top of the body");
  });

  it("6. verify on try: a running push shows its progress", () => {
    const h = expanded("r-20261005-newtab");
    assert.match(h, /<span class="state">412\/440, 0 failures<\/span>/);
  });

  it("7. meta bug: Bug to file, paste box and the checks blocking submission", () => {
    const h = expanded("r-20261008-permissions");
    assert.match(h, /Meta: Bug to file ↗/);
    assert.ok(h.includes(cmd({ cmd: "set-bug", request: "r-20261008-permissions", patch: "meta" })));
    assert.match(h, /<span class="bad">2 patches still say Bug XXXXXXX<\/span>/);
    assert.match(h, /data-copy="mozphab-r-20261008-permissions-[^"]*">Copy the moz-phab command<\/button>/, "the checks inform, you decide");
  });

  it("8. submit: the summary line tells try from the pushes made, not a declined one", () => {
    const r = structuredClone(get("r-20261007-focus"));
    r.pushes.x = { id: "x", purpose: "p", command: [], declined: "no" };
    assert.match(renderRequest(r, ctx, false).value, /· try: green<\/span>/);
    // Submitted: where its revisions stand, not try.
    r.step = "review comments";
    r.patches["p-focus"].revision = 5;
    assert.match(renderRequest(r, ctx, false).value, /· on Phabricator: waiting for review<\/span>/);
  });

  it("8. submit: checks pass, stack-viewer link, moz-phab command to copy", () => {
    const h = expanded("r-20261007-focus");
    assert.doesNotMatch(h, /class="bad"/);
    assert.match(h, /Open in stack-viewer ↗/);
    assert.match(h, /<textarea hidden id="mozphab-r-20261007-focus-focus">cd [^<]+ &amp;&amp; git switch [^<]+ &amp;&amp; moz-phab submit<\/textarea>/);
    assert.match(h, /data-copy="mozphab-r-20261007-focus-focus">Copy the moz-phab command<\/button>/);
    assert.ok(h.includes(cmd({ cmd: "copied-submit", request: "r-20261007-focus", stack: "focus" })), "copying it tells the factory to look for the revisions");
    assert.doesNotMatch(h, /run-moz-phab/);
  });

  it("9. review comments: Check Phabricator now, under a stack with revisions from review comments on", () => {
    const r = structuredClone(get("r-20261007-focus"));
    const button = cmd({ cmd: "poll-phab", request: "r-20261007-focus" });
    assert.ok(!renderRequest(r, ctx, true).value.includes(button), "not before it's submitted");
    r.patches["p-focus"].revision = 5;
    assert.ok(!renderRequest(r, ctx, true).value.includes(button), "not at submit");
    r.step = "review comments";
    assert.match(renderRequest(r, ctx, true).value, /<div class="stack-submit"><form class="inline cmd"[^]*?Check Phabricator now<\/button>/);
    r.step = "landing";
    assert.ok(renderRequest(r, ctx, true).value.includes(button));
    delete r.patches["p-focus"].revision;
    assert.ok(!renderRequest(r, ctx, true).value.includes(button), "not without revisions");
  });

  it("8. submit: the meta-bug comment can be copied, from the ⚑ area and from the stack, when there is a meta bug", () => {
    const h = expanded("r-20261008-permissions");
    assert.match(h, /<textarea hidden id="summary-r-20261008-permissions-permissions">/);
    assert.match(h, /data-copy="summary-r-20261008-permissions-permissions">Copy the meta-bug comment</);
    assert.match(h, /<textarea readonly rows="6" id="summary-r-20261008-permissions-permissions-body">/);
    // Collapsed, the ⚑ area still has what it copies.
    const closed = renderRequest(get("r-20261008-permissions"), ctx, false).value;
    assert.match(closed, /id="summary-r-20261008-permissions-permissions"/);
    // Every patch has its own bug: no meta-bug comment, and filing a meta bug is optional, depending on the stack's bugs.
    const focus = expanded("r-20261007-focus");
    assert.doesNotMatch(focus, /meta-bug comment/i);
    assert.match(focus, /A meta bug is optional here: <a href="https:\/\/bugzilla\.mozilla\.org\/enter_bug\.cgi\?[^"]*&amp;dependson=2080500&amp;bug_type=task/);
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
  });
  it("10. landing: landable patches and the moz-phab command", () => {
    const h = expanded("r-20261001-mouse-button");
    assert.match(h, /<span class="landable">landable<\/span>/);
    assert.match(h, /Stack reordered: 1 landable patch moved to the bottom/);
    assert.ok(h.includes(cmd({ cmd: "copied-reorg", request: "r-20261001-mouse-button", key: "land:mouse-button" })), "copying it answers the ⚑");
    assert.match(h, /<textarea hidden id="mozphab-reorg-r-20261001-mouse-button-mouse-button">cd \/build\/worktrees\/mouse-button && git switch ff\/mouse-button && moz-phab reorg<\/textarea>/);
    assert.match(h, /data-copy="mozphab-reorg-r-20261001-mouse-button-mouse-button">Copy the moz-phab reorg command</);
  });

  it("groups that landed outside a stack are under Landed, after those not in a stack yet", () => {
    const r = structuredClone(get("r-20261001-mouse-button"));
    const [first] = Object.values(r.items);
    r.items["i-gone"] = { ...first, id: "i-gone", state: "landed" };
    r.items["i-new"] = { ...first, id: "i-new", state: "waiting for review" };
    const h = renderRequest(r, ctx, true).value;
    const notYet = h.indexOf("<h3>Not in a stack yet</h3>");
    const landed = h.indexOf("<h3>Landed</h3>");
    assert.ok(notYet >= 0 && notYet < h.indexOf('data-item="i-new"') && h.indexOf('data-item="i-new"') < landed && landed < h.indexOf('data-item="i-gone"'));
    assert.doesNotMatch(expanded("r-20260930-errorsummary"), /Not in a stack yet/);
    assert.match(expanded("r-20260930-errorsummary"), /<h3>Landed<\/h3>/);
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

  it("shows only the config fields that have a value, in words, and nothing when the title already says it all", () => {
    assert.doesNotMatch(h, /From your request/, "the folder is already in the title");
    assert.doesNotMatch(h, /<b>tests<\/b>|\[\]/);
    const r = structuredClone(get(ID));
    r.config = { folders: [], tests: [], platforms: [], constraints: [] };
    assert.doesNotMatch(renderRequest(r, ctx, true).value, /From your request/);
  });

  it("lists the patch of a left-as-is group as dropped on the group's row, without a bug number", () => {
    assert.doesNotMatch(h, /Bug 0/);
    assert.doesNotMatch(h, /data-patch=/);
    assert.match(rowOf(h, "item-i-annotations"), /<div>Dropped patch: “Convert scoping skip-if[^”]*” <a href="\/requests\/[^"]+\/patches\/p-runif\/view"/);
    assert.match(rowOf(h, "item-i-annotations"), /<span class="state">closed: Dropped the run-if commit/, "the reason is the group's own line");
    assert.match(h, /<span class="closed">4 closed<\/span>/);
    assert.doesNotMatch(h, /<h3>Patches<\/h3>/, "no heading over dropped patches alone");
  });
  it("names tests relative to the request's folder, with the full path in its tooltip and the message under it", () => {
    const row = rowOf(h, "item-i-browser-policy-trackingprotection");
    assert.match(row, /<span class="name" title="browser\/components\/enterprisepolicies\/tests\/browser\/trackingprotection\/browser_policy_trackingprotection\.js\n[^"]*">trackingprotection\/browser_policy_trackingprotection\.js<\/span>/);
    assert.match(h, />browser_policy_sitepolicies_jit\.js<\/span>/);
    assert.match(row, /<div class="rowbody"><h4 class="part">The failure<\/h4><div class="failure">leaked 1 window\(s\) until shutdown \[url = about:preferences#etp\]<\/div>/);
  });
  it("shows running work in the group rows, with the group's cost at the end of its line", () => {
    assert.match(h, /<span class="end"><span class="cost" title="Agent cost of this group so far">\$0\.40<\/span><\/span><span class="state"><span class="working">investigating · <span data-since="2026-10-15T08:53:00.000Z">7 min<\/span><\/span><\/span>/);
    assert.match(h, /<span class="state"><span class="working">investigating · <span data-since="2026-10-15T08:54:00.000Z">6 min<\/span><\/span><\/span>/);
    assert.match(h, /<span class="state"><span class="working">building its worktree · <span data-since/);
  });
  it("puts the running groups first, then the others, and folds the closed ones with their full reasons", () => {
    const at = (item: string) => h.indexOf(`data-item="${item}"`);
    const fold = h.indexOf('<details class="fold" data-fold="closed-groups"><summary>4 closed</summary>');
    assert.ok(fold > 0);
    assert.ok(at("i-browser-policy-trackingprotection") < fold);
    for (const closed of ["i-annotations", "i-browser-policy-firefoxhome", "i-browser-policy-firefoxhome-2", "i-browser-policy-sitepolicies-jit"]) {
      assert.ok(at(closed) > fold, closed);
    }
    assert.match(rowOf(h, "item-i-annotations"), /<span class="cost" title="Agent cost of this group so far">\$0\.62<\/span><\/span><span class="state">closed: Dropped the run-if commit per review;[^<]*nothing left to convert and the DEBUG un-skip push showed no failures to fix\.<\/span>/);

    const r = structuredClone(get(ID));
    r.jobs["j-wt-sw2"].endedAt = "2026-10-15T09:00:00.000Z";
    r.items["i-browser-policy-firefoxhome"].state = "handed back";
    const h2 = renderRequest(r, ctx, true).value;
    assert.ok(h2.indexOf('data-item="i-browser-policy-trackingprotection"') < h2.indexOf('data-item="i-browser-policy-sitepolicies-serviceworke-2"'), "not started after running");
    assert.match(h2, /<summary>4 closed<\/summary>/);
  });
  it("offers to redo the skip-ifs group with today's skip-ifs, and only that group", () => {
    assert.ok(rowOf(h, "item-i-annotations").includes(cmd({ cmd: "redo-annotations", request: ID })));
    assert.match(rowOf(h, "item-i-annotations"), />Redo with today&#39;s skip-ifs<\/button>/);
    assert.doesNotMatch(rowOf(h, "item-i-browser-policy-firefoxhome"), /redo-annotations/);
    const r = structuredClone(get(ID));
    r.items["i-annotations"].state = "investigating";
    r.jobs["j-redo-run"] = { ...Object.values(r.jobs)[0], job: "j-redo-run", item: "i-annotations", endedAt: undefined };
    assert.doesNotMatch(renderRequest(r, ctx, true).value, /Redo with today/, "not while one of its jobs runs");
  });
  it("doesn't offer to file the bug a report drafted without a patch to attach", () => {
    assert.doesNotMatch(h, /Workers start slowly|enter_bug|tofile/);
  });
  it("lists the file names of a small group", () => {
    assert.match(h, /">browser_policy_managedbookmarks\.js, browser_policy_search_engine\.js<\/span>/);
  });
  it("lists a group's agents under it, newest first, with the scripts that run or failed, and folds the request's own jobs", () => {
    const row = rowOf(h, "item-i-browser-policy-sitepolicies-serviceworke-2");
    assert.match(row, /<div class="job"><span class="res run"><a href="\/api\/requests\/[^"]+\/jobs\/j-wt-sw2\/log" target="_blank" rel="noopener" title="Its output">build worktree<\/a><\/span>/, "a script opens its log");
    const tp = rowOf(h, "item-i-browser-policy-trackingprotection");
    assert.match(tp, /<span class="res run">investigating<\/span> <span class="sub">Opus · running/);
    assert.doesNotMatch(tp, /<span class="res ok">(lint message|build worktree)</);
    assert.doesNotMatch(h, /data-fold="jobs"[^]*j-inv-tp/, "a group's jobs aren't the request's");
  });
  it("shows under a failed build its error, and links to its mach profiles in the profiler", () => {
    const r = structuredClone(get(ID));
    r.jobs["j-wt-sw2"] = { ...r.jobs["j-wt-sw2"], endedAt: "2026-10-15T09:00:00.000Z", exitCode: 1, error: "built but can't run a mochitest", machProfiles: 1 };
    const row = rowOf(renderRequest(r, ctx, true).value, "item-i-browser-policy-sitepolicies-serviceworke-2");
    const url = encodeURIComponent(`http://factory:4300/api/requests/${ID}/jobs/j-wt-sw2/mach-profile-1`);
    assert.match(row, new RegExp(` · <a href="http://localhost:4242/from-url/${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>build profile</a>`));
    assert.match(row, /<span class="outcome clamp1" title="built but can&#39;t run a mochitest">built but can&#39;t run a mochitest<\/span>/);
  });

  it("shows each note of the request as its subject in bold, the rest when opened", () => {
    const r = structuredClone(get(ID));
    r.notes = [
      { t: "2026-10-15T08:00:00.000Z", text: "Dry run: try push A not made." },
      { t: "2026-10-15T08:00:00.000Z", text: "Shell in /wt done: a\nb" },
      { t: "2026-10-15T08:00:00.000Z", text: "Superseded by r-x." },
    ];
    const h = renderRequest(r, ctx, true).value;
    assert.match(h, /<details class="fold" data-fold="notes"><summary>\d+ notes?<\/summary><div class="notes"><details class="note" data-fold="[^"]*"><summary><b>Dry run<\/b> <span class="sub">Oct 15<\/span><\/summary><p>try push A not made\.<\/p><\/details>/);
    assert.match(h, /<b>Shell in \/wt done<\/b> <span class="sub">Oct 15 · 2 points<\/span><\/summary><ul><li>a<\/li><li>b<\/li><\/ul>/);
    assert.match(h, /<div class="note"><b>Superseded by r-x\.<\/b>/);
  });

  it("lets you tell the author of a ready patch what to change", () => {
    const r = structuredClone(get("r-20261013-tab-failures"));
    r.jobs["j-inv-close"] = { ...r.jobs["j-inv-spinner"], job: "j-inv-close", item: "i-close", endedAt: "2026-10-15T08:00:00.000Z", exitCode: 0, sessionId: "s-close" };
    r.items["i-close"].jobs.push("j-inv-close");
    const row = rowOf(renderRequest(r, ctx, true).value, "patch-p-close");
    assert.ok(row.includes(cmd({ cmd: "continue", request: r.id, item: "i-close" })));
    assert.match(row, />Send to its author</);
  });

  it("names the test a patch fixes on its second line, linked to its tests.firefox.dev dashboard", () => {
    const h = expanded("r-20261013-tab-failures");
    assert.match(
      rowOf(h, "patch-p-close"),
      /<span class="state">fixes <b><a href="https:\/\/tests\.firefox\.dev\/test\.html\?test=browser%2Fbase%2Fcontent%2Ftest%2Ftabs%2Fbrowser_tabCloseSpacer\.js" target="_blank" rel="noopener" title="Its failures on tests\.firefox\.dev">browser\/base\/content\/test\/tabs\/browser_tabCloseSpacer\.js<\/a><\/b> · reviewed: waiting for the rest of the stack<\/span>/,
    );
  });

  it("shows earlier recovery plans as history, without buttons", () => {
    const r = structuredClone(get("r-20261013-tab-failures"));
    r.needsUser = [];
    const h = renderRequest(r, ctx, true).value;
    const at = h.indexOf('data-fold="notes"><summary>');
    assert.ok(at > 0, "folded with the notes, with their count");
    const past = h.slice(at, h.indexOf("</details>", h.indexOf('<details class="note"', at)));
    assert.match(past, /<summary><b>You said: “the browser_tabSpinner agent has been at it for 6 hours”<\/b>/);
    assert.match(past, /<li>Can't do: Read the profile/);
    assert.doesNotMatch(past, /<form|checkbox|Run checked/);
  });

  it("shows on each investigated row the kinds of evidence and the reproduction, with links to its author's files", () => {
    const r = structuredClone(get(ID));
    const i = r.items["i-browser-policy-trackingprotection"];
    i.investigation = { state: "fix verified locally", summary: "s", cause: "the query holds the window", verification: "v", commits: [], landsAfter: [], feedback: [] };
    for (const j of i.jobs) r.jobs[j] = { ...r.jobs[j], endedAt: r.jobs[j].endedAt ?? "2026-10-15T08:59:00.000Z", exitCode: 0 };
    r.jobs["j-inv-tp"].sessionId = "s-tp";
    const trust = () => /<span class="trust">(.*?)<\/span><\/summary>/.exec(rowOf(renderRequest(r, ctx, true).value, `item-${i.id}`))?.[1] ?? "";
    assert.match(trust(), /^<span class="weak">Evidence not reported<\/span> · <span class="weak">Reproduction not reported<\/span> <form/);
    assert.match(trust(), />Ask its author<\/button>/, "its author can still say");
    assert.ok(trust().includes(cmd({ cmd: "continue", request: r.id, item: i.id })));
    i.investigation.evidence = [{ source: "code reading", finding: "f" }];
    i.investigation.reproduction = { reproduced: false, where: "locally", before: "0 of 50" };
    assert.match(trust(), /^Evidence: <span class="weak">code reading only<\/span> · <span class="bad">Not reproduced<\/span>/);
    i.investigation.evidence.push({ source: "profile", finding: "f" });
    i.investigation.reproduction = { reproduced: true, where: "on try", widened: true, before: "5 of 5 runs", after: "0 of 15" };
    i.investigation.files = { evidence: "artifacts/evidence.md", reproduction: "artifacts/reproduction.md", widening: "artifacts/reproduction.diff" };
    const files = `/requests/${r.id}/items/${i.id}/files`;
    const t = trust();
    assert.equal(
      t,
      `<a href="${files}/evidence" target="_blank" rel="noopener" title="artifacts/evidence.md">Evidence</a>: code reading, profile · <a href="${files}/reproduction" target="_blank" rel="noopener" title="artifacts/reproduction.md">Reproduced on try</a>, <a href="${files}/widening" target="_blank" rel="noopener" title="artifacts/reproduction.diff">race widened</a>: <span class="rates" title="5 of 5 runs → with the fix 0 of 15">5 of 5 runs → 0 of 15</span>`,
    );
    assert.doesNotMatch(t, /Ask its author/);
  });
  it("shows a group's cause under The fix, its verification folded", () => {
    const r = structuredClone(get(ID));
    const i = r.items["i-browser-policy-trackingprotection"];
    assert.doesNotMatch(rowOf(renderRequest(r, ctx, true).value, `item-${i.id}`), /The fix/, "nothing to show before a cause");
    i.investigation = { state: "fix verified locally", summary: "s", cause: "the query holds the window", verification: "ran it 50 times", commits: [], landsAfter: [], feedback: [] };
    const row = rowOf(renderRequest(r, ctx, true).value, `item-${i.id}`);
    assert.match(row, /<\/h4><div class="failure">[^]*<h4 class="part">The fix<\/h4><div class="why"><p><span class="sub">Cause:<\/span> the query holds the window<\/p><details class="fold" data-fold="verified-i-browser-policy-trackingprotection"><summary>How it was verified<\/summary><p>ran it 50 times<\/p><\/details><\/div>/);
    assert.doesNotMatch(row, /Allow one try push|allow-push/);
  });



  it("shows a patch's review effort and value only when known", () => {
    const h = expanded("r-20261013-tab-failures");
    const patch = rowOf(h, "patch-p-close");
    assert.match(patch, /review effort \d\/5/);
    assert.match(patch, /<div class="sub">\d+ configs? · [\d.]+ failures\/week · /);
    assert.match(patch, /<h4 class="part">The failure<\/h4>[^]*<h4 class="part">The fix<\/h4>[^]*<h4 class="part">What the factory did<\/h4>/, "in that order");
    const r = structuredClone(get("r-20261013-tab-failures"));
    delete r.patches["p-close"].effort;
    delete r.items["i-close"].group.ratePerWeek;
    const t = renderRequest(r, ctx, true).value;
    assert.doesNotMatch(t, /review effort|failures\/week/);
  });
  it("labels jobs by what they do", () => {
    assert.equal(jobLabel("worktree.ts create --build artifact"), "build worktree");
    assert.equal(jobLabel("lint-text.ts commit"), "lint message");
    assert.equal(jobLabel("failures.ts collect"), "collect failures");
    assert.equal(jobLabel("review-patch"), "critical review");
    assert.equal(jobLabel("draft-reply"), "draft-reply");
  });
});

describe("agent activity", () => {
  const log = readFileSync(resolve(FIXTURES, "../agents/stream-json-tools.jsonl"), "utf8");
  it("reads a run as a conversation: messages, tool calls with their output, in order", () => {
    const turns = conversationOf(log).map((t) => (t.kind === "call" ? `${t.tool}${t.subagent ? " in a subagent" : ""}${t.output === undefined ? "" : `: ${t.output}`}` : `${t.kind}: ${t.text}`));
    // The last line is still being written.
    assert.deepEqual(turns, ["said: I'll start by reading the test.", "Read: ...", "Grep", "Bash", "Agent", "Glob in a subagent", "Edit", "said: The spinner waits on a paint that never comes in headless mode."]);
  });

  it("shows the prompt, what the agent said, its tool calls on one line each, and its report last; no time or cost again", () => {
    const r = get("r-20261013-tab-failures");
    const job = { ...r.jobs["j-inv-spinner"], endedAt: "2026-10-15T08:00:00.000Z" };
    const turns = [...conversationOf(log), { kind: "call" as const, id: "t9", tool: "StructuredOutput", input: {} }];
    const summary = { done: true, report: { status: "fixed", summary: "Waits for the paint.", feedback: [], tests: ["a.js", "b.js"] }, costUsd: 0.5, toolUses: { count: 8, byName: {} } };
    const h = renderActivity(r.id, job, { prompt: "Fix browser_tabSpinner.js.\n", turns, summary, transcript: true }, ctx).value;
    assert.match(h, /^<div class="sub links"><a href="[^"]*\/transcript"[^>]*>Transcript<\/a><\/div>/);
    assert.doesNotMatch(h, /ran |\$0\.50|tool calls ·|StructuredOutput|Feedback/);
    const order = ['class="turn user prompt" data-expand', "I&#39;ll start by reading the test.", "<b>Read</b>", "<b>Edit</b>", 'class="turn agent report"'].map((x) => h.indexOf(x));
    assert.deepEqual([...order].sort((a, b) => a - b), order, "in order");
    assert.ok(!order.includes(-1));
    assert.match(h, /<details class="call" data-more="call-t3"><summary><b>Bash<\/b> <span class="mono">\.\/mach test browser\/base\/content\/test\/tabs\/browser_tabSpinner\.js --repeat 20<\/span>/);
    assert.match(h, /<pre class="in">\.\/mach test [^<]*\necho done<\/pre>/);
    assert.match(h, /<details class="call subagent" data-more="call-t5" title="in a subagent">/);
    assert.match(h, /<div class="turn agent report"><dl><dt>Status<\/dt><dd><span class="rtext">fixed<\/span>/);
    // A long run of tool calls: the last ones shown, the earlier ones folded.
    const many = Array.from({ length: 6 }, (_, n) => ({ kind: "call" as const, id: `c${n}`, tool: "Read", input: { file_path: `f${n}.js` }, output: "x" }));
    const m = renderActivity(r.id, job, { turns: many, summary: { done: false, toolUses: { count: 6, byName: {} } }, transcript: false }, ctx).value;
    assert.match(m, /<div class="calls"><details class="more" data-more="calls-c0"><summary>3 earlier tool calls<\/summary>(<details class="call" data-more="call-c[012]">[^]*?<\/details>){3}<\/details><details class="call" data-more="call-c3">/);
  });
});

describe("a group's jobs", () => {
  const r = structuredClone(get("r-20261013-tab-failures"));
  const base = r.jobs["j-inv-spinner"];
  const job = (id: string, extra: Partial<typeof base>) => {
    r.jobs[id] = { ...base, job: id, endedAt: "2026-10-15T04:00:00.000Z", exitCode: 0, ...extra };
    r.items["i-spinner"].jobs.push(id);
  };
  r.items["i-spinner"].jobs = [];
  job("j-a1", { costUsd: 1.5, model: "opus", purpose: { key: "author:i-spinner:1", what: "author", item: "i-spinner", reason: "initial" } });
  job("j-r1", { name: "review-patch", costUsd: 0.25, model: "sonnet", sessionId: "rv1", purpose: { key: "review:1", what: "review", item: "i-spinner" } });
  job("j-b1", { kind: "build", name: "worktree.ts create --build artifact", exitCode: 1, costUsd: undefined, model: undefined, sessionId: undefined });
  job("j-b2", { kind: "build", name: "worktree.ts create --build artifact", exitCode: 0, costUsd: undefined, model: undefined, sessionId: undefined });
  job("j-a2", { costUsd: 0.5, model: "opus", purpose: { key: "author:i-spinner:2", what: "author", item: "i-spinner", reason: "continue" } });
  job("j-x", { kind: "script", name: "lint-text.ts commit", exitCode: 2, costUsd: undefined, model: undefined, sessionId: undefined });

  it("shows the running ones and failures that still matter, the others on one line with their cost by model", () => {
    const run = structuredClone(r);
    run.jobs["j-a2"] = { ...run.jobs["j-a2"], endedAt: undefined, exitCode: undefined };
    const row = rowOf(renderRequest(run, ctx, true).value, "item-i-spinner");
    const jobs = row.slice(row.indexOf('<div class="jobs">'));
    assert.ok(jobs.startsWith('<div class="jobs"><details class="job" data-fold="job-j-x"') || jobs.includes('data-fold="job-j-a2"'));
    const fold = jobs.slice(jobs.indexOf('<details class="fold ended"'));
    const before = jobs.slice(0, jobs.indexOf('<details class="fold ended"'));
    assert.match(before, /data-fold="job-j-a2" data-watch="[^"]*" data-live>/, "running");
    assert.match(before, /lint message/, "a failure nothing ran again after");
    assert.doesNotMatch(before, /build worktree|data-fold="job-j-a1"|data-fold="job-j-r1"/);
    assert.match(fold, /^<details class="fold ended" data-fold="jobs-i-spinner"><summary>2 agent runs, 1 other job · <span class="cost" title="Opus \$1\.50 · Sonnet \$0\.25">\$1\.75<\/span><\/summary>/);
    assert.match(fold, /build worktree/, "the failed build that ran again since is in the fold");
    assert.doesNotMatch(row, /class="talk"/, "its author is running: nothing reaches it");
  });

  it("counts sessions when agents were resumed, and offers a box to talk to the latest author session only", () => {
    const row = rowOf(renderRequest(r, ctx, true).value, "item-i-spinner");
    assert.match(row, /<summary>3 agent runs in 2 sessions, 1 other job · /);
    const talk = (id: string) => new RegExp(`data-fold="job-${id}"[^]*?</summary><div class="activity">Loading…</div><div class="talk"><form`).test(row.slice(row.indexOf(`data-fold="job-${id}"`)).split("</details>")[0] + "</details>");
    assert.ok(talk("j-a1") && talk("j-a2"), "both runs of its session");
    assert.ok(!talk("j-r1"), "not a reviewer");
    assert.ok(row.includes(cmd({ cmd: "continue", request: r.id, item: "i-spinner" })));
    const closed = structuredClone(r);
    closed.items["i-spinner"].state = "left as-is";
    assert.doesNotMatch(rowOf(renderRequest(closed, ctx, true).value, "item-i-spinner"), /lint message[^]*<details class="fold ended"/, "failures of a closed group are folded");
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

  it("only links to https try push URLs, showing the jobs not scheduled yet", () => {
    const r = structuredClone(get("r-20261005-newtab"));
    r.pushes.v2.url = "javascript:alert(1)";
    r.pushes.v2.rev = "abc&x=<y>";
    const pages = [renderRequest(r, ctx, true).value, renderOverview([r], ctx)];
    for (const h of pages) {
      assert.doesNotMatch(h, /javascript:/);
      assert.ok(h.includes('href="https://treeherder.mozilla.org/jobs?repo=try&amp;revision=abc%26x%3D%3Cy%3E&amp;resultStatus=unscheduled%2Ctestfailed%2Cbusted%2Cexception%2Csuccess%2Cretry%2Cusercancel%2Crunning%2Cpending%2Crunnable"'));
    }
  });
});

describe("push status", () => {
  it("counts the requested test tasks when known, else Treeherder's jobs", () => {
    const p = { id: "initial", purpose: "verify", progress: { done: 30, total: 50, failures: 2 } } as unknown as Parameters<typeof pushStatus>[0];
    assert.equal(pushStatus(p), "30/50, 2 failures");
    assert.equal(pushStatus({ ...p, progress: { ...p.progress!, tests: { done: 7, total: 20 } } }), "7/20 test tasks, 2 failures");
  });
});

describe("a made push's row", () => {
  const ID = "r-20261013-dom-indexeddb";
  const job = (id: string, item: string, reason: string, key: string, extra = {}) =>
    ({ job: id, kind: "agent", name: "investigate-and-fix", item, purpose: { key, what: "author", item, reason }, startedAt: "2026-10-15T08:00:00.000Z", ...extra }) as unknown as RequestState["jobs"][string];
  // Tests named relative to the request's folder.
  const made = () => ({ ...structuredClone(get(ID)), folder: "dom/indexedDB/test/unit" });
  const stateOf = (row: string) => /<span class="state">(.*?)<\/span>/.exec(row)?.[1];
  const cell = (test: string, verdict: string, config = "linux") => ({ test: `dom/indexedDB/test/unit/${test}`, config, verdict, evidence: `why ${test}` }) as NonNullable<RequestState["pushes"][string]["analysis"]>[number];

  it("says what the factory made of its failures: verdict counts, then the list, its jobs and command folded", () => {
    const r = made();
    r.pushes.initial.analysis = [cell("test_a.js", "infra"), cell("test_b.js", "infra", "mac"), cell("test_c.js", "pre-existing")];
    const row = rowOf(renderRequest(r, ctx, true).value, "push-initial");
    assert.equal(stateOf(row), "14 failures, 2 groups · 2 infra · 1 pre-existing");
    assert.match(row, /<h4 class="part">What the factory made of its failures<\/h4><ul class="analysis"><li><b>infra<\/b>: test_a\.js <span class="sub">on linux<\/span><div class="sub clamp1"[^>]*>why test_a\.js<\/div><\/li>/);
    assert.match(row, /<details class="fold" data-fold="pushjobs-initial"><summary>Its jobs, commits and command<\/summary><pre class="mono command">/);
  });

  it("names the groups whose authors got its failures", () => {
    const r = made();
    r.jobs["j-a"] = job("j-a", "i-idb-quota", "try", "author:i-idb-quota:try:initial");
    r.jobs["j-b"] = job("j-b", "i-idb-quota", "try", "author:i-idb-quota:try:initial:final");
    r.jobs["j-other"] = job("j-other", "i-idb-upgrade", "try", "author:i-idb-upgrade:try:initial-2");
    assert.equal(stateOf(rowOf(renderRequest(r, ctx, true).value, "push-initial")), "14 failures, 2 groups · sent to the author of test_quota.js");
    r.jobs["j-other"] = job("j-other", "i-idb-upgrade", "try", "author:i-idb-upgrade:try:initial");
    assert.equal(stateOf(rowOf(renderRequest(r, ctx, true).value, "push-initial")), "14 failures, 2 groups · sent to the authors of test_quota.js, test_upgrade.js, test_upgrade_v2.js");
  });

  it("a push its author asked for: what that author made of it", () => {
    const r = made();
    r.pushes["idb-quota-ask-0a1b"] = { ...r.pushes.initial, id: "idb-quota-ask-0a1b" };
    delete (r.pushes as Record<string, unknown>).initial;
    const state = () => stateOf(rowOf(renderRequest(r, ctx, true).value, "push-idb-quota-ask-0a1b"));
    assert.equal(state(), "14 failures, 2 groups · results go to its author");
    r.jobs["j-ask"] = job("j-ask", "i-idb-quota", "asked push", "author:i-idb-quota:asked:j-1");
    assert.equal(state(), "14 failures, 2 groups · its author is reading the results");
    r.jobs["j-ask"] = job("j-ask", "i-idb-quota", "asked push", "author:i-idb-quota:asked:j-1", { endedAt: "2026-10-15T08:30:00.000Z", outcome: "fix verified locally: not its patch" });
    assert.equal(state(), "14 failures, 2 groups · its author: fix verified locally: not its patch");
  });

  it("a green push says only that", () => {
    const r = made();
    r.pushes.initial = { ...r.pushes.initial, result: "green", summary: "green" };
    const row = rowOf(renderRequest(r, ctx, true).value, "push-initial");
    assert.equal(stateOf(row), "green");
    assert.doesNotMatch(row, /What the factory made/);
  });
});

describe("failure table", () => {
  it("parses a job name into its OS, build and suite", () => {
    assert.deepEqual(parseConfig("test-linux2404-64-shippable/opt-mochitest-browser-chrome-swr"), { os: "Linux", build: "opt", suite: "browser-chrome-swr" });
    assert.deepEqual(parseConfig("test-linux2404-64-asan/opt-xpcshell"), { os: "Linux", build: "asan", suite: "xpcshell" });
    assert.deepEqual(parseConfig("test-linux1804-64-tsan-qr/opt-mochitest-plain"), { os: "Linux", build: "tsan", suite: "plain" });
    assert.deepEqual(parseConfig("test-windows11-64-25h2/debug-mochitest-browser-chrome-3"), { os: "Windows", build: "debug", suite: "browser-chrome" }, "chunks are one job");
    assert.deepEqual(parseConfig("test-linux2404-64-ccov/opt-xpcshell"), { os: "Linux", build: "ccov", suite: "xpcshell" });
    assert.deepEqual(parseConfig("test-windows11-64-24h2/debug-mochitest-devtools-chrome"), { os: "Windows", build: "debug", suite: "devtools-chrome" });
    assert.deepEqual(parseConfig("test-macosx1500-aarch64-shippable/opt-xpcshell"), { os: "macOS", build: "opt", suite: "xpcshell" });
    assert.deepEqual(parseConfig("test-android-em-7.0-x86_64-qr/debug-geckoview-junit"), { os: "Android", build: "debug", suite: "geckoview-junit" });
    assert.deepEqual(parseConfig("linux/opt-xpcshell"), { os: "Linux", build: "opt", suite: "xpcshell" }, "test- is optional");
    assert.equal(parseConfig("linux64/debug"), undefined, "no suite");
    assert.equal(parseConfig("source-test-foo/opt-x"), undefined, "unknown OS");
    assert.equal(parseConfig("xpcshell"), undefined);
  });

  it("lays configs out as job × OS, builds in order opt, debug, asan, tsan, ccov, and lists the others under it", () => {
    const t = configTable([
      "test-linux2404-64-ccov/opt-xpcshell",
      "test-windows11-64-24h2/debug-xpcshell",
      "test-linux2404-64-tsan/opt-xpcshell",
      "test-linux2404-64-asan/opt-xpcshell",
      "test-linux2404-64/debug-xpcshell",
      "test-linux2404-64-shippable/opt-xpcshell",
      "test-linux2404-64-shippable-qr/opt-xpcshell",
      "linux64/debug",
    ]).value;
    assert.match(t, /^<table class="ptable"><thead><tr><th>Job<\/th><th>Linux<\/th><th>Windows<\/th><\/tr><\/thead>/, "only the OSes it failed on, in a fixed order");
    assert.deepEqual([...t.matchAll(/<td class="mono">([^<]*)<\/td>/g)].map((m) => m[1]), ["opt xpcshell", "debug xpcshell", "asan xpcshell", "tsan xpcshell", "ccov xpcshell"]);
    assert.match(t, /<tr><td class="mono">opt xpcshell<\/td><td><span class="failbadge" title="test-linux2404-64-shippable\/opt-xpcshell\ntest-linux2404-64-shippable-qr\/opt-xpcshell">FAIL<\/span><\/td><td class="none">—<\/td><\/tr>/);
    assert.match(t, /<tr><td class="mono">debug xpcshell<\/td><td><span class="failbadge" title="test-linux2404-64\/debug-xpcshell">FAIL<\/span><\/td><td><span class="failbadge" title="test-windows11-64-24h2\/debug-xpcshell">FAIL<\/span><\/td><\/tr>/);
    assert.match(t, /<\/table><div class="sub">linux64\/debug<\/div>$/);
    assert.equal(configTable(["linux64/debug", "windows11-64/opt"]).value, '<div class="sub">linux64/debug, windows11-64/opt</div>', "no table when nothing parses");
  });
});
