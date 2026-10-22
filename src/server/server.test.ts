import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { createFactoryServer } from "./server.ts";
import { taskSetPath } from "../cli/task-set.ts";
import { fakeTaskSet } from "../../test/fixtures/try/task-set.ts";
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
    mdViewerCommand: [process.execPath, join(FIXTURES, "fake-md-viewer.js")],
    diffViewerCommand: [process.execPath, join(FIXTURES, "fake-md-viewer.js")],
    stateDir,
    worktreesDir: stateDir,
    firefoxRepo: "/build/firefox",
    maxAgents: 10,
    maxBuilds: 3,
    allowedHosts: ["factory.example"],
  },
  state,
  sink,
  now: () => Date.parse("2026-10-15T09:00:00Z"),
  machineName: "buildbox.corp.example",
  mozbuildStateDir: join(stateDir, "mozbuild"),
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
    assert.match(await (await fetch(`${base}/fragments/strip`)).text(), /id="strip"[^]*disk <b>[\d.]+ [GT]B<\/b> free/);
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

  it("refuses commands posted from another origin, such as an agent's sandboxed file", async () => {
    const form = new URLSearchParams({ command: JSON.stringify({ cmd: "tell-factory" }), text: "x", back: "/" });
    for (const origin of ["null", "https://evil.example"]) {
      assert.equal((await post(form.toString(), "application/x-www-form-urlencoded", { Origin: origin })).status, 403);
    }
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
    while (!text.includes("event: hello")) {
      text += decoder.decode((await reader.read()).value);
    }
    assert.match(text, /^retry: \d+\n\nevent: hello\ndata: "\d+"\n\n/, "the id of this run of the server, for the page to reload after a restart");
    state.set(state.getRequest("r-20261005-newtab")!);
    while (!text.includes("event: changed")) {
      text += decoder.decode((await reader.read()).value);
    }
    assert.match(text, /event: changed\ndata: "r-20261005-newtab"\n\n/);
    assert.equal(server.sseClientCount(), 1);
    controller.abort();
    while (server.sseClientCount() > 0) {
      await new Promise((done) => setTimeout(done, 5));
    }
  });

  it("ends the streams when the server closes", async () => {
    const other = createFactoryServer({ config: { port: 0, profilerOrigin: "", stackViewerCommand: [], worktreesDir: stateDir, firefoxRepo: stateDir, stateDir, maxAgents: 1, maxBuilds: 1 }, state, sink });
    await new Promise<void>((done) => other.listen(0, "127.0.0.1", done));
    const r = await fetch(`http://127.0.0.1:${(other.address() as AddressInfo).port}/events`);
    const reader = r.body!.getReader();
    await reader.read();
    const closed = new Promise<void>((done) => other.close(() => done()));
    while (!(await reader.read()).done) {
      // drain until the server ends the stream
    }
    await closed;
    assert.equal(other.sseClientCount(), 0);
  });
});

describe("Host check", () => {
  function get(host: string, path = "/"): Promise<number> {
    return new Promise((done, fail) => {
      const req = request(`${base}${path}`, { headers: { Host: host } }, (res) => {
        res.resume();
        done(res.statusCode!);
      });
      req.on("error", fail);
      req.end();
    });
  }

  it("answers IP literals, localhost, the machine's names and allowedHosts", async () => {
    for (const host of ["127.0.0.1:4300", "10.1.2.3", "[::1]:4300", "localhost:4300", "LOCALHOST", "buildbox", "buildbox.corp.example:4300", "factory.example"]) {
      assert.equal(await get(host), 200, host);
    }
  });

  it("links profiles to the factory's own front end, on the host the page was opened with", async () => {
    const own = createFactoryServer({ config: { port: 4300, stackViewerCommand: [], worktreesDir: stateDir, firefoxRepo: stateDir, stateDir, maxAgents: 1, maxBuilds: 1, allowedHosts: ["factory.example"] }, state, sink });
    await new Promise<void>((done) => own.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${(own.address() as AddressInfo).port}/`;
    const page = (host: string) =>
      new Promise<string>((done, fail) => {
        const req = request(url, { headers: { Host: host } }, (res) => {
          let body = "";
          res.setEncoding("utf8").on("data", (d: string) => (body += d)).on("end", () => done(body));
        });
        req.on("error", fail);
        req.end();
      });
    try {
      assert.match(await page("localhost:4300"), /href="http:\/\/localhost:4301\/from-url\/http%3A%2F%2Flocalhost%3A4300/);
      assert.match(await page("factory.example:4300"), /href="http:\/\/factory\.example:4301\/from-url\/http%3A%2F%2Ffactory\.example%3A4300/);
    } finally {
      await new Promise((done) => own.close(done));
    }
  });

  it("refuses other names, on every route", async () => {
    for (const host of ["evil.example", "buildbox.evil.example", "localhost.evil.example:4300", "1.2.3.4.evil.example", "127.0.0.1.nip.io"]) {
      assert.equal(await get(host), 421, host);
      assert.equal(await get(host, "/api/requests/r-20261010-xpcshell-cwd/profile"), 421, host);
    }
  });

  it("refuses commands whose Origin isn't the validated Host", async () => {
    sink.commands.length = 0;
    const port = new URL(base).port;
    const r = await post(JSON.stringify({ cmd: "tell-factory", text: "x" }), "application/json", { Origin: `http://localhost:${port}` });
    assert.equal(r.status, 403, "Host is 127.0.0.1, Origin localhost");
    const ok = await post(JSON.stringify({ cmd: "tell-factory", text: "x" }), "application/json", { Origin: base });
    assert.equal(ok.status, 200);
    assert.equal(sink.commands.length, 1);
  });
});

describe("interdiffs", () => {
  it("are read inside stateDir only", async () => {
    mkdirSync(join(stateDir, "interdiffs"), { recursive: true });
    writeFileSync(join(stateDir, "interdiffs", "ok.diff"), "+inside the state dir\n");
    const outside = mkdtempSync(join(tmpdir(), "ff-outside-"));
    writeFileSync(join(outside, "secret.diff"), "+secret\n");
    const r = structuredClone(state.getRequest("r-20261005-newtab")!);
    r.patches["p-sponsored"].interdiffFile = "interdiffs/ok.diff";
    r.patches["p-glean"].interdiffFile = relative(stateDir, join(outside, "secret.diff"));
    r.patches["p-nimbus"].interdiffFile = join(outside, "secret.diff");
    state.set(r);
    const page = await (await fetch(`${base}/fragments/requests/r-20261005-newtab?open=1`)).text();
    rmSync(outside, { recursive: true, force: true });
    assert.match(page, /<span class="a">\+inside the state dir<\/span>/);
    assert.doesNotMatch(page, /\+secret/);
    assert.equal((page.match(/can't be read/g) ?? []).length, 2);
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

describe("agent activity, transcript and profile", () => {
  const home = mkdtempSync(join(tmpdir(), "ff-home-"));
  const projects = join(home, ".claude", "projects", "-build-fix-factory-state");
  const profiler = join(home, "fake-profiler.js");
  const R = "/api/requests/r-20261013-tab-failures/jobs";
  const make = (claudeProfiler: string | null) =>
    createFactoryServer({
      config: { port: 0, profilerOrigin: "http://localhost:4242", stackViewerCommand: [], worktreesDir: stateDir, firefoxRepo: stateDir, stateDir, maxAgents: 10, maxBuilds: 3 },
      state,
      sink,
      now: () => Date.parse("2026-10-15T09:00:00Z"),
      homeDir: home,
      claudeProfiler,
    });
  const servers = [make(profiler), make(null)];
  const bases: string[] = [];

  before(async () => {
    mkdirSync(join(stateDir, "jobs", "j-inv-spinner"), { recursive: true });
    writeFileSync(join(stateDir, "jobs", "j-inv-spinner", "out.log"), readFileSync(join(FIXTURES, "../agents/stream-json-tools.jsonl")));
    writeFileSync(join(stateDir, "jobs", "j-inv-spinner", "prompt.md"), "Fix browser_tabSpinner.js.\n");
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, "3c1e.jsonl"), '{"type":"user"}\n{"type":"assistant"}\n');
    writeFileSync(join(home, "secret.jsonl"), "secret\n");
    symlinkSync(join(home, "secret.jsonl"), join(projects, "7d2a.jsonl"));
    writeFileSync(profiler, 'module.exports = { readJsonlFile: (p) => require("fs").readFileSync(p, "utf8").trim().split("\\n").map((l) => JSON.parse(l)), createFirefoxProfile: (e) => ({ entries: e.length }) };\n');
    for (const s of servers) {
      await new Promise<void>((done) => s.listen(0, "127.0.0.1", done));
      bases.push(`http://127.0.0.1:${(s.address() as AddressInfo).port}`);
    }
  });
  after(() => {
    for (const s of servers) {
      s.closeAllConnections();
      s.close();
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("shows an agent's run as a conversation, from its prompt, with links to its transcript and profile", async () => {
    const h = await (await fetch(`${bases[0]}${R}/j-inv-spinner/activity`)).text();
    assert.doesNotMatch(h, /running for|tool calls ·/, "its line says it already");
    assert.match(h, /<div class="convo"><div class="turn user prompt" data-expand title="Click to expand"><div class="md"><p>Fix browser_tabSpinner\.js\.<\/p><\/div><\/div><div class="turn agent"><div class="md"><p>I&#39;ll start by reading the test\.<\/p><\/div><\/div>/);
    assert.match(h, /<details class="call" data-more="call-t3"><summary><b>Bash<\/b> <span class="mono">\.\/mach test browser\/base\/content\/test\/tabs\/browser_tabSpinner\.js --repeat 20<\/span>/);
    assert.match(h, /<details class="call subagent" data-more="call-t5" title="in a subagent"><summary><b>Glob<\/b>/);
    assert.match(h, /<div class="turn agent"><div class="md"><p>The spinner waits on a paint that never comes in headless mode\.<\/p><\/div><\/div><div class="sub">working <span data-since/);
    assert.ok(h.includes(`href="${R}/j-inv-spinner/transcript"`));
    const api = encodeURIComponent(`${bases[0]}${R}/j-inv-spinner/profile`);
    assert.ok(h.includes(`href="http://localhost:4242/from-url/${api}?thread=0"`));
    assert.doesNotMatch(await (await fetch(`${bases[1]}${R}/j-inv-spinner/activity`)).text(), /Profile/, "no claude-profiler, no link");
    assert.match(await (await fetch(`${bases[0]}${R}/j-recover/activity`)).text(), /No output yet/);
    assert.equal((await fetch(`${bases[0]}${R}/j-nope/activity`)).status, 404);
  });

  it("serves the transcript and its profile from ~/.claude/projects only", async () => {
    assert.equal(await (await fetch(`${bases[0]}${R}/j-inv-spinner/transcript`)).text(), '{"type":"user"}\n{"type":"assistant"}\n');
    const profile = await fetch(`${bases[0]}${R}/j-inv-spinner/profile`);
    assert.equal(profile.headers.get("access-control-allow-origin"), "http://localhost:4242");
    assert.deepEqual(await profile.json(), { entries: 2 });
    assert.equal((await fetch(`${bases[1]}${R}/j-inv-spinner/profile`)).status, 404);
    assert.equal((await fetch(`${bases[0]}${R}/j-recover-2/transcript`)).status, 404, "a link out of the projects directory");
    assert.equal((await fetch(`${bases[0]}${R}/j-artifacts/transcript`)).status, 404, "a script has no session");
  });
});

describe("GET /requests/:id/stacks/:stack/review", () => {
  it("runs stack-viewer on the stack's range (in the main checkout once its worktree is gone) and injects the send button", async () => {
    const r = await fetch(`${base}/requests/r-20261010-xpcshell-cwd/stacks/storage-unit/review`);
    assert.equal(r.status, 200);
    const page = await r.text();
    const args = JSON.parse(page.match(/<pre id="args">(.*?)<\/pre>/)![1]);
    const first = state.getRequest("r-20261010-xpcshell-cwd")!.patches["p-prefs"].sha;
    assert.deepEqual(args.slice(0, 4), ["--no-open", "-R", "/build/firefox", "-o"]);
    assert.equal(args[5], `${first}^..ff/storage-unit`);
    assert.ok(page.indexOf('id="ff-send"') < page.indexOf("</body>"));
    assert.match(page, /Send comments to the factory/);
    assert.match(page, /mdvReviewComments/);
    const cfg = JSON.parse(page.match(/<script type="application\/json" id="ff-review-config">(.*?)<\/script>/)![1]);
    assert.equal(cfg.stack, "storage-unit");
    assert.equal(cfg.request, "r-20261010-xpcshell-cwd");
    assert.equal(cfg.shas[first], "p-prefs");
  });

  it("opens the stack of the request it's asked for when two requests have a stack of the same id", async () => {
    const other = structuredClone(state.getRequest("r-20261007-focus")!);
    other.stacks["storage-unit"] = { ...other.stacks.focus, id: "storage-unit", worktree: stateDir };
    state.set(other);
    const page = await (await fetch(`${base}/requests/r-20261007-focus/stacks/storage-unit/review`)).text();
    assert.equal(JSON.parse(page.match(/<pre id="args">(.*?)<\/pre>/)![1])[2], stateDir);
    assert.equal(JSON.parse(page.match(/<script type="application\/json" id="ff-review-config">(.*?)<\/script>/)![1]).request, "r-20261007-focus", "its comments go to that request");
    delete other.stacks["storage-unit"];
    state.set(other);
  });

  it("takes the base from the URL", async () => {
    const page = await (await fetch(`${base}/requests/r-20261010-xpcshell-cwd/stacks/storage-unit/review?base=central`)).text();
    assert.match(page, /&quot;central\.\.ff\/storage-unit&quot;|"central\.\.ff\/storage-unit"/);
  });

  it("refuses a base that isn't a revision name", async () => {
    for (const bad of ["--upload-pack=touch /tmp/x", "-n", "a..b", "a b", ""]) {
      const r = await fetch(`${base}/requests/r-20261010-xpcshell-cwd/stacks/storage-unit/review?base=${encodeURIComponent(bad)}`);
      assert.equal(r.status, 400, bad);
    }
  });

  it("uses the stack's own base", async () => {
    const page = await (await fetch(`${base}/requests/r-20261007-focus/stacks/focus/review`)).text();
    assert.match(page, /&quot;central\.\.ff\/focus&quot;|"central\.\.ff\/focus"/);
  });

  it("reports stack-viewer failures and unknown stacks", async () => {
    const r = await fetch(`${base}/requests/r-20261010-xpcshell-cwd/stacks/storage-unit/review?base=fail`);
    assert.equal(r.status, 502);
    assert.match(await r.text(), /bad revision/);
    assert.equal((await fetch(`${base}/requests/r-20261010-xpcshell-cwd/stacks/nope/review`)).status, 404);
  });
});

describe("GET /api/requests/:id/jobs/:job/log and mach-profile-<n>", () => {
  it("serves a job's output, and its mach profiles to the profiler", async () => {
    const dir = join(stateDir, "jobs", "j-recover");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "err.log"), "0:01 build failed\n");
    writeFileSync(join(dir, "out.log"), '{"error":"x"}\n');
    writeFileSync(join(dir, "mach-profile-1.json"), '{"meta":{}}');
    const J = `${base}/api/requests/r-20261013-tab-failures/jobs/j-recover`;
    assert.equal(await (await fetch(`${J}/log`)).text(), '== stderr ==\n0:01 build failed\n\n== stdout ==\n{"error":"x"}\n');
    const profile = await fetch(`${J}/mach-profile-1`);
    assert.equal(profile.headers.get("access-control-allow-origin"), "http://localhost:4242");
    assert.equal(await profile.text(), '{"meta":{}}');
    assert.equal((await fetch(`${J}/mach-profile-2`)).status, 404);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("GET /api/requests/:id/pushes/:push/tasks", () => {
  it("lays out what a planned push would run, from its latest dry run", async () => {
    const ID = "r-20261014-extensions-xpcshell";
    const r = structuredClone(state.getRequest(ID)!);
    r.jobs["j-dry"].purpose = { key: "dry-run:unskip", what: "dry-run", push: "unskip" };
    state.set(r);
    const dir = join(stateDir, "jobs", "j-dry");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "out.log"), JSON.stringify({ command: ["./mach", "try", "fuzzy"], taskCount: 2, tasks: ["test-b", "test-a"], tryTaskConfig: {}, commits: [], warnings: ["2 labels are chunk patterns"] }));
    const page = await (await fetch(`${base}/api/requests/${ID}/pushes/unskip/tasks`)).text();
    assert.match(page, /<th>Other <span class="btype">opt<\/span><\/th><td><span class="job" title="test-a">test-a<\/span> <span class="job" title="test-b">test-b<\/span>/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the jobs of a dry run that didn't record them from its worktree's task set", async () => {
    const ID = "r-20261014-extensions-xpcshell";
    const r = structuredClone(state.getRequest(ID)!);
    const wt = mkdtempSync(join(tmpdir(), "ff-wt-"));
    // Another dry run than the one above, whose lack of jobs the server remembers.
    r.jobs["j-dry2"] = { ...r.jobs["j-dry"], job: "j-dry2", cwd: wt, purpose: { key: "dry-run:unskip", what: "dry-run", push: "unskip" } };
    state.set(r);
    const file = taskSetPath(wt, false, join(stateDir, "mozbuild"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, fakeTaskSet());
    const dir = join(stateDir, "jobs", "j-dry2");
    mkdirSync(dir, { recursive: true });
    const tasks = ["test-linux2404-64/debug-xpcshell-*"];
    writeFileSync(join(dir, "out.log"), JSON.stringify({ command: ["./mach", "try", "fuzzy"], taskCount: 1, tasks, tryTaskConfig: { tasks }, commits: [], warnings: [] }));
    const page = await (await fetch(`${base}/api/requests/${ID}/pushes/unskip/tasks`)).text();
    assert.match(page, /<th>Linux <span class="btype">debug<\/span><\/th><td><span class="job" title="build-linux64\/debug">B<\/span>/);
    assert.match(page, /<th>Linux 24\.04 <span class="btype">debug<\/span><\/th><td><span class="jgroup">X\( <span class="job"[^>]*>X1<\/span> <span class="job"[^>]*>X2<\/span> \)/);
    assert.equal((await fetch(`${base}/api/requests/${ID}/pushes/nope/tasks`)).status, 404);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("GET /requests/:id/items/:item/files/:which", () => {
  it("renders its author's evidence and reproduction with md-viewer and its widening patch with diff-viewer, from its worktree only", async () => {
    const ID = "r-20261015-enterprisepolicies";
    const r = structuredClone(state.getRequest(ID)!);
    const wt = mkdtempSync(join(tmpdir(), "ff-wt-"));
    mkdirSync(join(wt, "artifacts"));
    writeFileSync(join(wt, "artifacts", "evidence.md"), "# The query holds the window\n");
    writeFileSync(join(wt, "artifacts", "reproduction.diff"), "--- a\n+++ b\n");
    const i = r.items["i-browser-policy-trackingprotection"];
    r.jobs["j-inv-tp"].cwd = wt;
    i.investigation = { state: "fix verified locally", summary: "s", cause: "c", verification: "v", commits: [], landsAfter: [], feedback: [], files: { evidence: "artifacts/evidence.md", reproduction: "../outside.md", widening: "artifacts/reproduction.diff" } };
    state.set(r);
    const url = (which: string) => `${base}/requests/${ID}/items/${i.id}/files/${which}`;
    const evidence = await (await fetch(url("evidence"))).text();
    assert.match(evidence, /<pre id="args">\["-n","--no-open","--",".*\/artifacts\/evidence\.md"\]<\/pre><pre id="text"># The query holds the window/);
    const widening = await (await fetch(url("widening"))).text();
    assert.match(widening, /"--no-open","-t","widening: [^"]*","-o"/);
    assert.equal((await fetch(url("reproduction"))).status, 404, "not outside the worktree");
    assert.equal((await fetch(url("other"))).status, 404);
    rmSync(wt, { recursive: true, force: true });
  });
});

describe("GET /requests/:id/patches/:patch/view", () => {
  it("runs stack-viewer on the patch alone, in its worktree or the main checkout once that is gone, with a button sending comments to its author", async () => {
    const p = state.getRequest("r-20261010-xpcshell-cwd")!.patches["p-prefs"];
    const r = await fetch(`${base}/requests/r-20261010-xpcshell-cwd/patches/p-prefs/view`);
    assert.equal(r.status, 200);
    const page = await r.text();
    const args = JSON.parse(page.match(/<pre id="args">(.*?)<\/pre>/)![1]);
    assert.deepEqual(args.slice(0, 3), ["--no-open", "-R", "/build/firefox"]);
    assert.equal(args.at(-1), `${p.sha}^..${p.sha}`);
    const cfg = JSON.parse(page.match(/<script type="application\/json" id="ff-review-config">(.*?)<\/script>/)![1]);
    assert.deepEqual(cfg, { request: "r-20261010-xpcshell-cwd", patch: "p-prefs", shas: { [p.sha]: "p-prefs" } });
    assert.match(page, /cmd: "comment-fix"/);
  });

  it("refuses unknown requests and patches", async () => {
    assert.equal((await fetch(`${base}/requests/r-20261010-xpcshell-cwd/patches/nope/view`)).status, 404);
    assert.equal((await fetch(`${base}/requests/nope/patches/p-prefs/view`)).status, 404);
  });
});

describe("agent files: symlinks and script", () => {
  it("refuses a symlink out of the worktree and serves the page sandboxed, without script", async () => {
    const ID = "r-20261015-enterprisepolicies";
    const r = structuredClone(state.getRequest(ID)!);
    const wt = mkdtempSync(join(tmpdir(), "ff-wt-"));
    const outside = mkdtempSync(join(tmpdir(), "ff-outside-"));
    writeFileSync(join(outside, "secret.md"), "secret\n");
    mkdirSync(join(wt, "artifacts"));
    writeFileSync(join(wt, "artifacts", "evidence.md"), "<script>fetch('/api/commands', { method: 'POST' })</script>\n");
    symlinkSync(join(outside, "secret.md"), join(wt, "artifacts", "reproduction.md"));
    const i = r.items["i-browser-policy-trackingprotection"];
    r.jobs["j-inv-tp"].cwd = wt;
    i.investigation = { state: "fix verified locally", summary: "s", cause: "c", verification: "v", commits: [], landsAfter: [], feedback: [], files: { evidence: "artifacts/evidence.md", reproduction: "artifacts/reproduction.md" } };
    state.set(r);
    const url = (which: string) => `${base}/requests/${ID}/items/${i.id}/files/${which}`;
    const evidence = await fetch(url("evidence"));
    assert.equal(evidence.status, 200);
    assert.match(evidence.headers.get("content-security-policy")!, /^sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; /);
    assert.equal((await fetch(url("reproduction"))).status, 404, "symlink out of the worktree");
    rmSync(wt, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
});
