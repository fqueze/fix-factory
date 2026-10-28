// client.js runs in a vm context with just enough of a page for its setup code.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { runInNewContext } from "node:vm";

const CLIENT = readFileSync(join(import.meta.dirname, "client.js"), "utf8");
const MIN = 60 * 1000;

type Field = { value: string; defaultValue: string };

function loadPage(visibilityState: "visible" | "hidden", fields: Field[] = []) {
  const listeners = new Map<string, (() => void)[]>();
  const sse = new Map<string, (event: { data: string }) => void>();
  let connections = 0;
  const sent: { url: string; body: unknown; keepalive: unknown }[] = [];
  const selectors: string[] = [];
  let reloads = 0;
  const document = {
    visibilityState,
    body: { dataset: { boot: "1" } },
    activeElement: null as Field | null,
    querySelectorAll: (selector: string) => {
      selectors.push(selector);
      return selector === "input[type=text], textarea" ? fields : [];
    },
    addEventListener(type: string, f: () => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), f]);
    },
  };
  const page = {
    document,
    EventSource: class {
      constructor() {
        connections++;
      }
      close() {}
      addEventListener(type: string, f: (event: { data: string }) => void) {
        sse.set(type, f);
      }
    },
    fetch(url: string, init: { body: string; keepalive?: boolean }) {
      sent.push({ url, body: JSON.parse(init.body), keepalive: init.keepalive });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    },
    setInterval,
    clearInterval,
    setTimeout,
    Date,
    location: {
      hash: "",
      pathname: "/",
      search: "",
      reload() {
        reloads++;
      },
    },
    history: { replaceState() {} },
  };
  runInNewContext(CLIENT, page);
  return {
    sent,
    selectors,
    document,
    reloads: () => reloads,
    hello: (id: string) => sse.get("hello")!({ data: JSON.stringify(id) }),
    ping: () => sse.get("ping")!({ data: "" }),
    connections: () => connections,
    setVisibility(v: "visible" | "hidden") {
      document.visibilityState = v;
      for (const f of listeners.get("visibilitychange") ?? []) f();
    },
  };
}

describe("presence", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] }));
  afterEach(() => mock.timers.reset());

  it("sends presence when visible, on each visibility change, and every 15 min while visible", () => {
    const page = loadPage("visible");
    assert.deepEqual(page.sent, [{ url: "/api/commands", body: { cmd: "presence", visible: true }, keepalive: true }]);
    mock.timers.tick(15 * MIN);
    assert.equal(page.sent.length, 2);
    page.setVisibility("hidden");
    assert.deepEqual(page.sent[2].body, { cmd: "presence", visible: false });
    mock.timers.tick(60 * MIN);
    assert.equal(page.sent.length, 3);
    page.setVisibility("visible");
    assert.deepEqual(page.sent[3].body, { cmd: "presence", visible: true });
    // The interval restarts from the visibility change.
    mock.timers.tick(14 * MIN);
    assert.equal(page.sent.length, 4);
    mock.timers.tick(1 * MIN);
    assert.equal(page.sent.length, 5);
  });

  it("skips a visible send less than a minute after the last one", () => {
    const page = loadPage("visible");
    page.setVisibility("hidden");
    page.setVisibility("visible");
    assert.deepEqual(
      page.sent.map((s) => (s.body as { visible: boolean }).visible),
      [true, false],
    );
    page.setVisibility("hidden");
    mock.timers.tick(1 * MIN);
    page.setVisibility("visible");
    assert.deepEqual(
      page.sent.map((s) => (s.body as { visible: boolean }).visible),
      [true, false, false, true],
    );
  });

  it("sends nothing from a page opened in the background", () => {
    const page = loadPage("hidden");
    mock.timers.tick(60 * MIN);
    assert.deepEqual(page.sent, []);
  });
});

describe("live events", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] }));
  afterEach(() => mock.timers.reset());

  it("reconnects when the server's heartbeats stop arriving (a machine waking from sleep), not while they do", () => {
    const page = loadPage("visible");
    for (let i = 0; i < 10; i++) {
      mock.timers.tick(30000);
      page.ping();
    }
    assert.equal(page.connections(), 1);
    mock.timers.tick(80000);
    assert.equal(page.connections(), 2);
  });
});

describe("agent conversations", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] }));
  afterEach(() => mock.timers.reset());

  it("reloads the open ones of running agents only, every 3 s", () => {
    const page = loadPage("visible");
    page.selectors.length = 0;
    mock.timers.tick(3000);
    assert.ok(page.selectors.includes("details[data-watch][data-live][open]"));
    assert.ok(!page.selectors.includes("details[data-watch][open]"));
  });
});

describe("reload after a server restart", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] }));
  afterEach(() => mock.timers.reset());

  it("reloads a page served by an earlier run on its first hello, not one served by this run", () => {
    const page = loadPage("visible");
    page.hello("1");
    assert.equal(page.reloads(), 0);
    page.hello("2");
    assert.equal(page.reloads(), 1);
  });

  it("waits while you type, with a single poller, and a cleared field isn't typing", () => {
    const field = { value: "draft", defaultValue: "" };
    const page = loadPage("visible", [field]);
    page.hello("2");
    page.hello("3");
    assert.equal(page.reloads(), 0);
    // Sent: the field is emptied but its form wasn't re-rendered.
    field.value = "";
    mock.timers.tick(5000);
    assert.equal(page.reloads(), 1);
  });

  it("counts a focused field with text, even as rendered", () => {
    const field = { value: "drafted reply", defaultValue: "drafted reply" };
    const page = loadPage("visible", [field]);
    page.document.activeElement = field;
    page.hello("2");
    assert.equal(page.reloads(), 0);
    page.document.activeElement = null;
    mock.timers.tick(5000);
    assert.equal(page.reloads(), 1);
  });
});
