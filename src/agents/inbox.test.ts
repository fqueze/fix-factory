import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { delivered, sendToInbox } from "./inbox.ts";

test("the hook hands a session its new messages once, after a tool call, and records when", () => {
  const state = mkdtempSync(join(tmpdir(), "inbox-"));
  try {
    const hook = (session: string) => execFileSync(process.execPath, [join(import.meta.dirname, "inbox.ts"), state], { input: JSON.stringify({ session_id: session, hook_event_name: "PostToolUse" }) }).toString();
    assert.equal(hook("s-1"), "", "nothing for it");
    sendToInbox(state, "s-1", { id: "c1", text: "Also check macOS.", t: "2026-11-16T12:00:00.000Z" });
    const out = JSON.parse(hook("s-1"));
    assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.match(out.hookSpecificOutput.additionalContext, /^A message from the user, sent while you were working:\nAlso check macOS\./);
    assert.equal(hook("s-1"), "", "once");
    assert.equal(hook("s-2"), "", "another session's");
    assert.ok(delivered(state, "s-1").has("c1"));
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});
