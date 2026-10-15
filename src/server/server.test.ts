import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { createFactoryServer } from "./server.ts";
import { FixtureStateSource, MemoryCommandSink, MemoryStateSource } from "./state-source.ts";

const FIXTURES = resolve(import.meta.dirname, "../../test/fixtures/server");
const fixtures = new FixtureStateSource(FIXTURES);
const state = new MemoryStateSource(
  fixtures.listRequests(),
  Object.fromEntries(fixtures.listRequests().map((r) => [r.id, fixtures.getEvents(r.id)])),
);
const sink = new MemoryCommandSink();
const stateDir = mkdtempSync(join(tmpdir(), "ff-server-test-"));
const server = createFactoryServer({
  config: {
    port: 0,
    profilerOrigin: "http://localhost:4242",
    stackViewerCommand: [process.execPath, join(FIXTURES, "fake-stack-viewer.js")],
    stateDir,
    maxAgents: 10,
    maxBuilds: 3,
  },
  state,
  sink,
  now: () => Date.parse("2026-10-15T09:00:00Z"),
});
let base = "";

before(async () => {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
  rmSync(stateDir, { recursive: true, force: true });
});

function post(body: string, type: string, headers: Record<string, string> = {}) {
  return fetch(`${base}/api/commands`, { method: "POST", body, headers: { "Content-Type": type, ...headers }, redirect: "manual" });
}

describe("pages", () => {
  it("serves the overview, the client script and the style sheet", async () => {
    const r = await fetch(`${base}/`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type")!, /text\/html/);
    const page = await r.text();
    assert.match(page, /<h2>Active/);
    // The Profile link points back at the address the browser used.
    assert.ok(page.includes(encodeURIComponent(`${base}/api/requests/`)));
    assert.equal((await fetch(`${base}/client.js`)).status, 200);
    assert.match(await (await fetch(`${base}/style.css`)).text(), /--action-bg/);
  });

  it("expands the request named in the URL", async () => {
    const page = await (await fetch(`${base}/requests/r-20261005-newtab`)).text();
    assert.match(page, /id="req-r-20261005-newtab" data-request="r-20261005-newtab" data-section="active" open>/);
    assert.match(page, /Draft reply/);
    assert.equal((await fetch(`${base}/requests/r-nope`)).status, 404);
  });

  it("serves a request's fragment, collapsed or open", async () => {
    const closed = await (await fetch(`${base}/fragments/requests/r-20261005-newtab`)).text();
    assert.match(closed, /^<details class="req needs"/);
    assert.doesNotMatch(closed, /Draft reply/);
    const open = await (await fetch(`${base}/fragments/requests/r-20261005-newtab?open=1`)).text();
    assert.match(open, /Draft reply/);
    assert.match(await (await fetch(`${base}/fragments/strip`)).text(), /id="strip"/);
    assert.match(await (await fetch(`${base}/fragments/main`)).text(), /<h2>Active/);
  });
});

describe("POST /api/commands", () => {
  it("appends a form's command and redirects back", async () => {
    sink.commands.length = 0;
    const form = new URLSearchParams({ command: JSON.stringify({ cmd: "approve-push", request: "r-20261010-xpcshell-cwd", push: "A" }), back: "/requests/r-20261010-xpcshell-cwd" });
    const r = await post(form.toString(), "application/x-www-form-urlencoded");
    assert.equal(r.status, 303);
    assert.equal(r.headers.get("location"), "/requests/r-20261010-xpcshell-cwd");
    assert.deepEqual(sink.commands, [{ cmd: "approve-push", request: "r-20261010-xpcshell-cwd", push: "A" }]);
  });

  it("answers JSON to the client script", async () => {
    sink.commands.length = 0;
    const form = new URLSearchParams({ command: JSON.stringify({ cmd: "tell-factory" }), text: "Lando was down", back: "https://evil.example/" });
    const r = await post(form.toString(), "application/x-www-form-urlencoded", { Accept: "application/json" });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, appended: 1 });
    assert.deepEqual(sink.commands, [{ cmd: "tell-factory", text: "Lando was down" }]);
  });

  it("only redirects to local paths", async () => {
    const form = new URLSearchParams({ command: JSON.stringify({ cmd: "tell-factory" }), text: "x", back: "//evil.example/" });
    const r = await post(form.toString(), "application/x-www-form-urlencoded");
    assert.equal(r.headers.get("location"), "/");
  });

  it("accepts JSON, and appends nothing when one command is invalid", async () => {
    sink.commands.length = 0;
    const r = await post(JSON.stringify([{ cmd: "tell-factory", text: "a" }, { cmd: "approve-push", request: "r-20261010-xpcshell-cwd", push: "nope" }]), "application/json");
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /unknown push nope/);
    assert.deepEqual(sink.commands, []);
  });

  it("refuses commands posted from another site", async () => {
    sink.commands.length = 0;
    const r = await post(JSON.stringify({ cmd: "shell", cwd: "/", command: "rm -rf ~", reason: "x" }), "application/json", { Origin: "https://evil.example" });
    assert.equal(r.status, 403);
    const r2 = await post("command=x", "application/x-www-form-urlencoded", { "Sec-Fetch-Site": "cross-site" });
    assert.equal(r2.status, 403);
    assert.deepEqual(sink.commands, []);
  });

  it("rejects other content types", async () => {
    assert.equal((await post("x", "text/plain")).status, 415);
  });
});

describe("GET /events", () => {
  it("sends a changed event with the request id", async () => {
    const controller = new AbortController();
    const r = await fetch(`${base}/events`, { signal: controller.signal });
    assert.equal(r.headers.get("content-type"), "text/event-stream");
    const reader = r.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    text += decoder.decode((await reader.read()).value);
    assert.match(text, /^retry: \d+/);
    state.set(state.getRequest("r-20261005-newtab")!);
    while (!text.includes("event: changed")) {
      text += decoder.decode((await reader.read()).value);
    }
    assert.match(text, /event: changed\ndata: "r-20261005-newtab"\n\n/);
    controller.abort();
  });
});

describe("GET /api/requests/:id/profile", () => {
  it("serves the profile to the profiler origin", async () => {
    const r = await fetch(`${base}/api/requests/r-20261010-xpcshell-cwd/profile`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("access-control-allow-origin"), "http://localhost:4242");
    const p = await r.json();
    assert.equal(p.meta.version, 64);
    assert.ok(p.threads.length > 1);
    const pre = await fetch(`${base}/api/requests/r-20261010-xpcshell-cwd/profile`, { method: "OPTIONS" });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "http://localhost:4242");
    assert.equal((await fetch(`${base}/api/requests/r-nope/profile`)).status, 404);
  });
});

describe("GET /stacks/:stack/review", () => {
  it("runs stack-viewer on the stack's range and injects the send button", async () => {
    const r = await fetch(`${base}/stacks/storage-unit/review`);
    assert.equal(r.status, 200);
    const page = await r.text();
    const args = JSON.parse(page.match(/<pre id="args">(.*?)<\/pre>/)![1]);
    const first = state.getRequest("r-20261010-xpcshell-cwd")!.patches["p-prefs"].sha;
    assert.deepEqual(args.slice(0, 4), ["--no-open", "-R", "/build/worktrees/storage-unit", "-o"]);
    assert.equal(args[5], `${first}^..ff/storage-unit`);
    assert.ok(page.indexOf('id="ff-send"') < page.indexOf("</body>"));
    assert.match(page, /Send comments to the factory/);
    assert.match(page, /mdvReviewComments/);
    const cfg = JSON.parse(page.match(/<script type="application\/json" id="ff-review-config">(.*?)<\/script>/)![1]);
    assert.equal(cfg.stack, "storage-unit");
    assert.equal(cfg.request, "r-20261010-xpcshell-cwd");
    assert.equal(cfg.shas[first], "p-prefs");
  });

  it("takes the base from the URL", async () => {
    const page = await (await fetch(`${base}/stacks/storage-unit/review?base=central`)).text();
    assert.match(page, /&quot;central\.\.ff\/storage-unit&quot;|"central\.\.ff\/storage-unit"/);
  });

  it("reports stack-viewer failures and unknown stacks", async () => {
    const r = await fetch(`${base}/stacks/storage-unit/review?base=fail`);
    assert.equal(r.status, 502);
    assert.match(await r.text(), /bad revision/);
    assert.equal((await fetch(`${base}/stacks/nope/review`)).status, 404);
  });
});
