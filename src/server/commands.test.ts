import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { commandsFromForm, parseBugNumber, validateCommand } from "./commands.ts";
import { FixtureStateSource } from "./state-source.ts";

const source = new FixtureStateSource(resolve(import.meta.dirname, "../../test/fixtures/server"));
const get = (id: string) => source.getRequest(id);
const R = "r-20261010-xpcshell-cwd";

describe("validateCommand", () => {
  it("accepts each kind of command the page sends", () => {
    const ok = [
      { cmd: "new-request", kind: "burndown", text: "", folder: "dom/base/test" }, // no longer sent, still accepted
      { cmd: "approve-push", request: R, push: "A" },
      { cmd: "set-bug", request: R, patch: "p-copydir", bug: 2081216 },
      { cmd: "set-bug", request: R, patch: "meta", bug: 2081217 },
      { cmd: "comment-bug-draft", request: R, patch: "p-copydir", text: "Use Core::Networking" },
      { cmd: "stack-comments", request: R, stack: "storage-unit", comments: [{ patch: "p-prefs", text: "why?" }] },
      { cmd: "take-it", request: R, item: "i-update" },
      { cmd: "hand-back", request: R, item: "i-update" },
      { cmd: "comment-fix", request: R, patch: "p-prefs", text: "rename it" },
      { cmd: "tell-factory", text: "Lando was down" },
      { cmd: "reply-recovery", request: "r-20261013-tab-failures", job: "j-recover", text: "no" },
      { cmd: "start-now", request: "r-20261016-popups" },
    ];
    for (const c of ok) {
      const v = validateCommand(c, get);
      assert.ok(v.ok, `${c.cmd}: ${v.ok ? "" : v.error}`);
      assert.deepEqual(v.command, c);
    }
  });

  describe("recovery commands", () => {
    const T = "r-20261013-tab-failures";
    const state = structuredClone(source.getRequest(T)!);
    const planned = [
      { cmd: "set-state", item: "i-drag", state: "left as-is", reason: "dup" },
      { cmd: "redo-step", step: "verify on try", reason: "re-plan" },
      { cmd: "edit-config", config: { platforms: ["linux"], nested: { a: [1, 2] } }, reason: "asked" },
      { cmd: "start-agent", item: "i-pin", prompt: "investigate-and-fix", reason: "retry" },
      { cmd: "retry-job", job: "j-inv-spinner", reason: "lando" },
      { cmd: "cancel-job", job: "j-inv-spinner", reason: "stuck" },
    ] as const;
    state.recoveryPlans.push({ job: "j-recover", text: "more", plan: [...planned], cannotDo: [], questions: [], t: state.createdAt });
    const getT = (id: string) => (id === T ? state : get(id));

    it("are accepted when they are an entry of one of the request's plans", () => {
      for (const c of [...state.recoveryPlans[0].plan, ...planned]) {
        const v = validateCommand({ ...c, request: T }, getT);
        assert.ok(v.ok, `${c.cmd}: ${v.ok ? "" : v.error}`);
        assert.deepEqual(v.command, { ...c, request: T });
      }
    });

    it("are refused otherwise", () => {
      const bad = [
        { cmd: "shell", cwd: "/tmp", command: "rm -rf ~", reason: "look" },
        { cmd: "shell", cwd: "/build/worktrees/spinner", command: "git stash list", reason: "look" },
        { cmd: "edit-config", request: T, config: { platforms: ["linux"], nested: { a: [1, 3] } }, reason: "asked" },
        { cmd: "shell", request: T, cwd: "/build/worktrees/spinner", command: "git stash list; rm -rf ~", reason: "Check whether it left uncommitted experiments." },
        { cmd: "set-state", request: R, item: "i-update", state: "left as-is", reason: "dup" },
      ];
      for (const c of bad) {
        const v = validateCommand(c, getT);
        assert.equal(v.ok, false, JSON.stringify(c));
        assert.match((v as { error: string }).error, /needs a request|not in a recovery plan/);
      }
    });
  });

  it("rejects malformed commands", () => {
    const bad: [unknown, RegExp][] = [
      ["nope", /JSON object/],
      [{ cmd: "rm-rf" }, /unknown command/],
      [{ cmd: "set-bug", request: R, patch: "p-copydir", bug: "2081216" }, /bug must be a positive integer/],
      [{ cmd: "tell-factory", text: "  " }, /non-empty/],
      [{ cmd: "set-state", request: R, item: "i-update", state: "done", reason: "x" }, /state must be one of/],
      [{ cmd: "approve-push", push: "A" }, /needs a request/],
      [{ cmd: "approve-push", request: "r-nope", push: "A" }, /unknown request/],
      [{ cmd: "approve-push", request: R, push: "Z" }, /unknown push Z/],
      [{ cmd: "take-it", request: R, item: "i-nope" }, /unknown item/],
      [{ cmd: "stack-comments", request: R, stack: "storage-unit", comments: [] }, /non-empty list/],
      [{ cmd: "stack-comments", request: R, stack: "storage-unit", comments: [{ patch: "p-nope", text: "x" }] }, /unknown patch p-nope/],
      [{ cmd: "new-request", kind: "burndown", text: "x" }, /needs a folder/],
      [{ cmd: "run-moz-phab", request: R, stack: "storage-unit", args: ["submit"] }, /./],
    ];
    for (const [c, re] of bad) {
      const v = validateCommand(c, get);
      assert.equal(v.ok, false, JSON.stringify(c));
      assert.match((v as { error: string }).error, re);
    }
  });

  it("drops fields that aren't part of the command", () => {
    const v = validateCommand({ cmd: "tell-factory", text: "hi", id: "forged", v: 9 }, get);
    assert.deepEqual(v, { ok: true, command: { cmd: "tell-factory", text: "hi" } });
  });
});

describe("forms", () => {
  it("parses bug numbers in the forms people paste them", () => {
    assert.equal(parseBugNumber("2081216"), 2081216);
    assert.equal(parseBugNumber(" Bug 2081216 "), 2081216);
    assert.equal(parseBugNumber("https://bugzilla.mozilla.org/show_bug.cgi?id=2081216"), 2081216);
    assert.equal(parseBugNumber("https://bugzil.la/2081216"), 2081216);
    assert.equal(parseBugNumber("2081216 is a dup"), null);
  });

  it("turns the bug box into set-bug or comment-bug-draft", () => {
    const template = JSON.stringify({ cmd: "set-bug", request: R, patch: "p-copydir" });
    assert.deepEqual(commandsFromForm(new URLSearchParams({ command: template, bugOrText: "bug 2081216" })), [{ cmd: "set-bug", request: R, patch: "p-copydir", bug: 2081216 }]);
    assert.deepEqual(commandsFromForm(new URLSearchParams({ command: template, bugOrText: "Should be Core::Networking" })), [
      { cmd: "comment-bug-draft", request: R, patch: "p-copydir", text: "Should be Core::Networking" },
    ]);
  });

  it("fills the typed text in, and keeps every checked command", () => {
    const form = new URLSearchParams();
    form.append("command", JSON.stringify({ cmd: "retry-job", job: "a", reason: "x" }));
    form.append("command", JSON.stringify({ cmd: "retry-job", job: "b", reason: "y" }));
    assert.equal(commandsFromForm(form).length, 2);
    assert.deepEqual(commandsFromForm(new URLSearchParams({ command: '{"cmd":"tell-factory"}', text: "hello" })), [{ cmd: "tell-factory", text: "hello" }]);
  });
});
