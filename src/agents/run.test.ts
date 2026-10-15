import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendFeedback,
  buildAgentCommand,
  parseStreamJson,
  promptVersion,
  renderPrompt,
  transcriptPath,
  validateReport,
  type JsonSchema,
} from "./run.ts";

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../../test/fixtures/agents/${name}`, import.meta.url)), "utf8");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "agents-run-test-"));
}

test("renderPrompt fills placeholders, including multi-line values and names with spaces", () => {
  const out = renderPrompt("Fix {test} in {worktree}.\nThe failure: {failure summary}.\nJSON: {\"a\": 1}", {
    test: "browser_foo.js",
    worktree: "/w/foo",
    "failure summary": "line 1\nline 2 {not expanded}",
  });
  assert.equal(out, "Fix browser_foo.js in /w/foo.\nThe failure: line 1\nline 2 {not expanded}.\nJSON: {\"a\": 1}");
});

test("renderPrompt fills a placeholder used twice", () => {
  assert.equal(renderPrompt("{a}-{a}", { a: 1 }), "1-1");
});

test("renderPrompt lists every missing variable", () => {
  assert.throws(() => renderPrompt("{a} {b} {c} {b}", { a: "x" }), /missing: b, c$/);
});

test("buildAgentCommand with a new session", () => {
  const schema = { type: "object" };
  assert.deepEqual(buildAgentCommand({ claudeCommand: ["mozsb", "claude"] }, { prompt: "do it", model: "opus", schema, sessionId: "s1" }), [
    "mozsb", "claude", "-p", "do it", "--output-format", "stream-json", "--verbose",
    "--session-id", "s1", "--model", "opus", "--json-schema", '{"type":"object"}',
  ]);
});

test("buildAgentCommand resuming a session", () => {
  const cmd = buildAgentCommand({ claudeCommand: ["claude"] }, { prompt: "go on", model: "haiku", schema: '{"type":"object"}', resume: "s1" });
  assert.deepEqual(cmd.slice(5, 8), ["--verbose", "--resume", "s1"]);
  assert.ok(!cmd.includes("--session-id"));
  assert.equal(cmd.at(-1), '{"type":"object"}');
});

test("parseStreamJson on a finished run", () => {
  const s = parseStreamJson(fixture("stream-json-haiku.jsonl"));
  assert.equal(s.done, true);
  assert.equal(s.sessionId, "2dc1f50a-5673-4b34-88f4-2524f9bb3896");
  assert.deepEqual(s.report, { state: "ok", note: "ready" });
  assert.equal(s.resultText, '{"state":"ok","note":"ready"}');
  assert.equal(s.costUsd, 0.02786375);
  assert.equal(s.durationMs, 2355);
  assert.equal(s.numTurns, 2);
  assert.equal(s.isError, false);
  assert.equal(s.model, "claude-haiku-4-5-20251001");
  assert.deepEqual(s.toolUses, { count: 1, byName: { StructuredOutput: 1 } });
  assert.equal(s.lastAssistantText, undefined);
});

test("parseStreamJson on a resumed run reports the session's cumulative cost", () => {
  const first = parseStreamJson(fixture("stream-json-haiku.jsonl"));
  const resumed = parseStreamJson(fixture("stream-json-haiku-resume.jsonl"));
  assert.equal(resumed.done, true);
  assert.equal(resumed.sessionId, first.sessionId);
  assert.equal(resumed.costUsd, 0.0311093);
  assert.ok(resumed.costUsd! > first.costUsd!);
});

test("parseStreamJson tolerates a log still being written", () => {
  const lines = fixture("stream-json-haiku.jsonl").split("\n");
  const partial = lines.slice(0, 5).join("\n") + "\n" + lines[5].slice(0, 40);
  const s = parseStreamJson(partial);
  assert.equal(s.done, false);
  assert.equal(s.report, undefined);
  assert.equal(s.sessionId, "2dc1f50a-5673-4b34-88f4-2524f9bb3896");
  assert.equal(s.model, "claude-haiku-4-5-20251001");
  assert.equal(s.toolUses.count, 1);
  assert.deepEqual(parseStreamJson(""), { done: false, toolUses: { count: 0, byName: {} } });
});

test("parseStreamJson keeps the last top-level assistant text and counts every tool use", () => {
  const msg = (content: unknown[], parent: string | null = null) =>
    JSON.stringify({ type: "assistant", parent_tool_use_id: parent, message: { content } });
  const s = parseStreamJson([
    msg([{ type: "text", text: "first" }, { type: "tool_use", name: "Bash" }]),
    msg([{ type: "tool_use", name: "Bash" }, { type: "tool_use", name: "Read" }]),
    msg([{ type: "text", text: "second" }]),
    msg([{ type: "text", text: "from a subagent" }, { type: "tool_use", name: "Grep" }], "toolu_1"),
  ].join("\n"));
  assert.equal(s.lastAssistantText, "second");
  assert.deepEqual(s.toolUses, { count: 4, byName: { Bash: 2, Read: 1, Grep: 1 } });
});

test("validateReport", () => {
  const schema: JsonSchema = {
    type: "object",
    properties: {
      n: { type: "integer" },
      x: { type: "number" },
      b: { type: "boolean" },
      e: { type: "string", enum: ["a", "b"] },
      list: { type: "array", items: { type: "object", properties: { s: { type: "string" } }, required: ["s"], additionalProperties: false } },
      free: { type: "object" },
    },
    required: ["n", "e"],
    additionalProperties: false,
  };
  assert.deepEqual(validateReport(schema, { n: 1, x: 1.5, b: true, e: "a", list: [{ s: "" }], free: { any: 1 } }), []);
  assert.deepEqual(validateReport(schema, { n: 1.5, x: "1", e: "c", list: [{}, { s: 1, t: 2 }], extra: 0 }), [
    "$.n: expected integer, got number",
    "$.x: expected number, got string",
    '$.e: "c" is not one of "a", "b"',
    "$.list[0].s: required",
    "$.list[1].s: expected string, got number",
    "$.list[1].t: unexpected property",
    "$.extra: unexpected property",
  ]);
  assert.deepEqual(validateReport(schema, null), ["$: expected object, got null"]);
  assert.deepEqual(validateReport(schema, [1]), ["$: expected object, got array"]);
});

test("validateReport with anyOf reports the closest branch", () => {
  const branch = (cmd: string, field: string): JsonSchema => ({
    type: "object",
    properties: { cmd: { type: "string", enum: [cmd] }, [field]: { type: "string" } },
    required: ["cmd", field],
    additionalProperties: false,
  });
  const schema: JsonSchema = { type: "array", items: { anyOf: [branch("a", "job"), branch("b", "item")] } };
  assert.deepEqual(validateReport(schema, [{ cmd: "a", job: "j" }, { cmd: "b", item: "i" }]), []);
  assert.deepEqual(validateReport(schema, [{ cmd: "b", job: "j" }]), ["$[0].item: required", "$[0].job: unexpected property"]);
});

test("appendFeedback appends one entry per item to each target's file", () => {
  const dir = tempDir();
  try {
    const now = new Date("2026-10-15T12:00:00Z");
    appendFeedback(dir, "job-1", [
      { target: "fx-tests", text: "the failure list missed a config" },
      { target: "factory", text: "multi\nline" },
    ], now);
    appendFeedback(dir, "job-2", [{ target: "fx-tests", text: "second" }], now);
    assert.equal(
      readFileSync(join(dir, "feedback", "fx-tests.md"), "utf8"),
      "## 2026-10-15T12:00:00.000Z — job job-1\n\nthe failure list missed a config\n\n" +
        "## 2026-10-15T12:00:00.000Z — job job-2\n\nsecond\n\n",
    );
    assert.equal(readFileSync(join(dir, "feedback", "factory.md"), "utf8"), "## 2026-10-15T12:00:00.000Z — job job-1\n\nmulti\nline\n\n");
    assert.throws(() => appendFeedback(dir, "job-3", [{ target: "../x" as "factory", text: "" }]), /invalid feedback target/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("transcriptPath mangles the cwd like Claude Code", () => {
  assert.equal(transcriptPath("/home/u", "/build/fix-factory/artifacts/probe", "abc"), "/home/u/.claude/projects/-build-fix-factory-artifacts-probe/abc.jsonl");
  assert.equal(
    transcriptPath("/home/u", "/build/worktrees/test_2_conformance2__extensions__ovr_multiview2_draw_buffers", "abc"),
    "/home/u/.claude/projects/-build-worktrees-test-2-conformance2--extensions--ovr-multiview2-draw-buffers/abc.jsonl",
  );
  assert.equal(transcriptPath("/h", "/build/fix-factory/.claude/worktrees/x", "s"), "/h/.claude/projects/-build-fix-factory--claude-worktrees-x/s.jsonl");
});

test("promptVersion is the git blob sha", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "empty.md"), "");
    writeFileSync(join(dir, "hello.md"), "hello\n");
    assert.equal(promptVersion(join(dir, "empty.md")), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    assert.equal(promptVersion(join(dir, "hello.md")), "ce013625030ba8dba906f756967f9e9ca394464a");
  } finally {
    rmSync(dir, { recursive: true });
  }
});
