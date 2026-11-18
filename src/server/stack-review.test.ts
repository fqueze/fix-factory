// The script a review page with annotations gets, in a vm context with just enough of stack-viewer's page.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { injectSendButton } from "./stack-review.ts";
import type { Annotations } from "./review-annotations.ts";

const SHA = "a".repeat(40);

function loadPage() {
  const annotations: Annotations = { commits: { [SHA]: { draftKey: "r-1:p-a", status: { kind: "unreviewed", label: "Not approved yet", tooltip: "t" }, sections: [], titleLinks: [{ text: "Bug XXXXXXX", href: "x" }], actions: [{ id: "approve", label: "Approve", kind: "button", at: "end", tooltip: "t" }, { id: "set-bug", label: "Bug number", kind: "input", placeholder: "1", tooltip: "t" }, { id: "send", label: "Send comments to the factory", kind: "button", at: "end", tooltip: "t" }], comments: [] } } };
  const page = injectSendButton("<body></body>", { request: "r-1", stack: "root", shas: { [SHA]: "p-a" }, annotations, bugDrafts: { "p-a": { summary: "Popup left open", title: "Wait for the popup", patches: ["p-a"] } } });
  const script = page.match(/<script>([\s\S]*?)<\/script>/)![1];
  const filing: unknown[] = [];
  const config = page.match(/<script type="application\/json" id="ff-review-config">(.*?)<\/script>/)![1];
  const sent: unknown[] = [];
  const marked: string[][] = [];
  const updated: [string, { status: { kind: string }; actions: { id: string; label?: string; disabled?: boolean }[]; titleLinks?: unknown[] }][] = [];
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
    ffBugWatch: { add: (d: unknown) => filing.push(d) },
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
  return { sent, marked, updated, button, filing, fire: (type: string, detail: object) => listeners.get(type)!({ detail }), action: (detail: object) => listeners.get("mdv-action")!({ detail }) };
}

const settle = () => new Promise((done) => setImmediate(done));

describe("the review page's script", () => {
  it("approves a commit, then shows it approved in place; a bug number goes as set-bug", async () => {
    const p = loadPage();
    p.action({ commit: SHA.slice(0, 12), id: "approve" });
    await settle();
    assert.deepEqual(p.sent, [{ cmd: "approve", patch: "p-a", sha: SHA, request: "r-1" }]);
    assert.deepEqual([p.updated[0][0], p.updated[0][1].status.kind, p.updated[0][1].actions.map((a) => a.id)], [SHA, "approved", ["set-bug", "send"]]);
    p.action({ commit: SHA, id: "set-bug", value: "Bug 2081216" });
    await settle();
    assert.deepEqual(p.sent[1], { cmd: "set-bug", patch: "p-a", bug: 2081216, request: "r-1" });
  });

  it("sends new comments and answers once, marks them sent, and stays usable for what comes next", async () => {
    const p = loadPage();
    const send = () => p.action({ commit: SHA.slice(0, 12), id: "send" });
    const sendButton = () => p.updated.at(-1)![1].actions.find((a) => a.id === "send")!;
    send();
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
    assert.deepEqual([sendButton().label, sendButton().disabled], ["Sent 1 comment and 1 answer", false], "on the Send clicked");
    send();
    await settle();
    assert.equal(p.sent.length, 1, "nothing new: nothing sent");
    assert.equal(sendButton().label, "Nothing new to send");
  });

  it("keeps the bug to file whose link you followed for bug-watch.js, and once its bug is recorded links it under its number and drops the field", () => {
    const p = loadPage();
    p.fire("mdv-link", { commit: SHA, text: "bug 1234567", href: "x" });
    p.fire("mdv-link", { commit: SHA.slice(0, 12), text: "Bug XXXXXXX", href: "x" });
    assert.deepEqual(JSON.parse(JSON.stringify(p.filing)), [{ request: "r-1", patch: "p-a", summary: "Popup left open", title: "Wait for the popup" }]);
    p.fire("ff-bug-recorded", { request: "r-1", patch: "p-a", bug: 2000001 });
    assert.deepEqual([p.updated[0][0], p.updated[0][1].actions.map((a) => a.id)], [SHA, ["approve", "send"]]);
    assert.deepEqual(JSON.parse(JSON.stringify(p.updated[0][1].titleLinks)), [{ text: "Bug XXXXXXX", href: "https://bugzilla.mozilla.org/show_bug.cgi?id=2000001", label: "Bug 2000001", tooltip: "The factory puts it in the commit message" }], "the link goes to the bug, under its number");
  });
});
