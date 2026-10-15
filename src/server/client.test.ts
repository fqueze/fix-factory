// client.js runs in a vm context with just enough of a page for its setup code.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { runInNewContext } from "node:vm";

const CLIENT = readFileSync(join(import.meta.dirname, "client.js"), "utf8");
const MIN = 60 * 1000;

function loadPage(visibilityState: "visible" | "hidden") {
  const listeners = new Map<string, (() => void)[]>();
  const sent: { url: string; body: unknown; keepalive: unknown }[] = [];
  const document = {
    visibilityState,
    querySelectorAll: () => [],
    addEventListener(type: string, f: () => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), f]);
    },
  };
  const page = {
    document,
    EventSource: class {
      addEventListener() {}
    },
    fetch(url: string, init: { body: string; keepalive?: boolean }) {
      sent.push({ url, body: JSON.parse(init.body), keepalive: init.keepalive });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    },
    setInterval,
    clearInterval,
    setTimeout,
    Date,
  };
  runInNewContext(CLIENT, page);
  return {
    sent,
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
