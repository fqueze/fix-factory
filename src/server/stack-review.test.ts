// The script a review page with annotations gets, in a vm context with just enough of stack-viewer's page.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { injectSendButton } from "./stack-review.ts";
import type { Annotations } from "./review-annotations.ts";

const SHA = "a".repeat(40);

function loadPage() {
  const annotations: Annotations = { commits: { [SHA]: { status: { kind: "unreviewed", label: "Not approved yet" }, sections: [], titleLinks: [{ text: "Bug XXXXXXX", href: "x" }], actions: [{ id: "approve", label: "Approve", kind: "button", tooltip: "t" }, { id: "set-bug", label: "Bug number", kind: "input", placeholder: "1", tooltip: "t" }], comments: [] } } };
  const page = injectSendButton("<body></body>", { request: "r-1", stack: "root", shas: { [SHA]: "p-a" }, annotations });
  const script = page.match(/<script>([\s\S]*?)<\/script>/)![1];
  const config = page.match(/<script type="application\/json" id="ff-review-config">(.*?)<\/script>/)![1];
  const sent: unknown[] = [];
  const marked: string[][] = [];
  const updated: [string, { status: { kind: string }; actions: { id: string }[] }][] = [];
  const listeners = new Map<string, (e: unknown) => void>();
  const button = { textContent: "Send comments to the factory", disabled: false, click: () => {}, addEventListener: (_: string, f: () => void) => (button.click = f) };
  let comments = [{ id: "c-1", text: "Why?", quote: "x", line: 3, anchor: { file: "(commit)", line: 3 } }];
  let responses = [{ id: "phab-4", response: "ignore" }];
  const frame = {
    document: { querySelector: () => ({ getAttribute: () => SHA.slice(0, 12) }) },
    mdvReviewComments: () => comments,
    mdvReviewResponses: () => responses,
    mdvReviewMarkSent: (ids: string[]) => {
      marked.push(ids);
      comments = [];
      responses = [];
    },
  };
  const window: Record<string, unknown> = {
    addEventListener: (type: string, f: (e: unknown) => void) => listeners.set(type, f),
    mdvSetAnnotations: (sha: string, a: (typeof updated)[number][1]) => updated.push([sha, structuredClone(a)]),
  };
  const document = {
    getElementById: (id: string) => (id === "ff-send" ? button : { textContent: config }),
    querySelectorAll: () => [{ contentWindow: frame }],
  };
  window.document = document;
  const fetch = (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body));
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
  };
  runInNewContext(script, { window, document, fetch, setTimeout: () => 0, JSON, Number, String });
  return { sent, marked, updated, button, action: (detail: object) => listeners.get("mdv-action")!({ detail }) };
}

const settle = () => new Promise((done) => setImmediate(done));

describe("the review page's script", () => {
  it("approves a commit, then shows it approved in place; a bug number goes as set-bug", async () => {
    const p = loadPage();
    p.action({ commit: SHA.slice(0, 12), id: "approve" });
    await settle();
    assert.deepEqual(p.sent, [{ cmd: "approve", patch: "p-a", sha: SHA, request: "r-1" }]);
    assert.deepEqual([p.updated[0][0], p.updated[0][1].status.kind, p.updated[0][1].actions.map((a) => a.id)], [SHA, "approved", ["set-bug"]]);
    p.action({ commit: SHA, id: "set-bug", value: "Bug 2081216" });
    await settle();
    assert.deepEqual(p.sent[1], { cmd: "set-bug", patch: "p-a", bug: 2081216, request: "r-1" });
  });

  it("sends new comments and answers once, marks them sent, and stays usable for what comes next", async () => {
    const p = loadPage();
    p.button.click();
    await settle();
    assert.deepEqual(p.sent, [
      {
        cmd: "review-send",
        comments: [{ patch: "p-a", text: "Why?", anchor: { file: "(commit)", line: 3 }, sha: SHA, quote: "x", id: "c-1" }],
        responses: [{ patch: "p-a", id: "phab-4", response: "ignore" }],
        request: "r-1",
      },
    ]);
    assert.deepEqual(JSON.parse(JSON.stringify(p.marked)), [["c-1", "phab-4"]]);
    assert.equal(p.button.disabled, false);
    p.button.click();
    await settle();
    assert.equal(p.sent.length, 1, "nothing new: nothing sent");
  });
});
