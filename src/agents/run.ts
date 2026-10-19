// Pure parts of the agent runner: prompt rendering, the claude command line, stream-json parsing,
// report validation, feedback files and transcript paths. Starting the process is src/state/jobs.ts's job.

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FactoryConfig, Feedback, JobId } from "../types.ts";

// ---------------------------------------------------------------------------
// Prompts

// Identifiers only, so JSON examples such as {"a": 1} and code such as {return x} in a prompt are left alone.
const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

export function renderPrompt(template: string, vars: Record<string, string | number>): string {
  const missing = new Set<string>();
  for (const m of template.matchAll(PLACEHOLDER)) {
    if (!Object.hasOwn(vars, m[1])) missing.add(m[1]);
  }
  if (missing.size) {
    throw new Error(`prompt variables missing: ${[...missing].join(", ")}`);
  }
  // A single pass, so a value that itself contains {braces} isn't expanded again.
  return template.replace(PLACEHOLDER, (_, name: string) => String(vars[name]));
}

// Git blob sha of the file, as `git hash-object` computes it, without spawning git.
export function promptVersion(path: string): string {
  const content = readFileSync(path);
  return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

// ---------------------------------------------------------------------------
// Command line

// The prompt itself goes on stdin (job spec stdinFile), not in argv: Linux limits one argument to 128 KiB.
export type AgentCommandOptions = {
  model: string;
  schema: object | string; // a parsed schema, or its JSON text
} & ({ sessionId: string; resume?: undefined } | { resume: string; sessionId?: undefined });

// Builds and test runs take longer than Claude Code's 10-minute command limit. Without a higher one,
// agents run them in the background, and a headless session ends before they finish. no-push.ts
// refuses any push: an instruction alone isn't enough.
// It reads the one-push allowances you give (allow-push/<session> in the state directory).
// The hook command is a shell line; paths may have spaces.
const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const agentSettings = (stateDir: string) =>
  JSON.stringify({
    env: { BASH_DEFAULT_TIMEOUT_MS: "7200000", BASH_MAX_TIMEOUT_MS: "7200000" },
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: [process.execPath, join(import.meta.dirname, "no-push.ts"), stateDir].map(shellQuote).join(" ") }] }] },
  });

export function buildAgentCommand(config: Pick<FactoryConfig, "claudeCommand" | "stateDir">, opts: AgentCommandOptions): string[] {
  const schema = typeof opts.schema === "string" ? opts.schema : JSON.stringify(opts.schema);
  const session = opts.resume !== undefined ? ["--resume", opts.resume] : ["--session-id", opts.sessionId];
  return [
    ...config.claudeCommand,
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    ...session,
    "--model",
    opts.model,
    "--json-schema",
    schema,
    "--settings",
    agentSettings(config.stateDir),
  ];
}

// ---------------------------------------------------------------------------
// stream-json

export interface StreamSummary {
  done: boolean; // the result line was seen
  sessionId?: string;
  report?: unknown; // structured_output
  resultText?: string;
  // total_cost_usd. After a --resume, claude reports the cost of the whole session so far (checked on
  // stream-json-haiku-resume.jsonl), so subtract the previous runs' cost to get this run's.
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  isError?: boolean;
  model?: string; // from the system init line
  toolUses: { count: number; byName: Record<string, number> };
  lastAssistantText?: string;
}

interface ContentBlock {
  type?: string;
  name?: string;
  text?: string;
}

export function parseStreamJson(text: string): StreamSummary {
  const out: StreamSummary = { done: false, toolUses: { count: 0, byName: {} } };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(line);
    } catch {
      // The log may still be being written: the last line can be cut short.
      continue;
    }
    if (typeof msg !== "object" || msg === null) continue;
    if (typeof msg.session_id === "string") out.sessionId ??= msg.session_id;

    if (msg.type === "system" && msg.subtype === "init") {
      if (typeof msg.model === "string") out.model = msg.model;
    } else if (msg.type === "assistant") {
      const content: ContentBlock[] = Array.isArray(msg.message?.content) ? msg.message.content : [];
      for (const block of content) {
        if (block.type === "tool_use" && typeof block.name === "string") {
          out.toolUses.count++;
          out.toolUses.byName[block.name] = (out.toolUses.byName[block.name] ?? 0) + 1;
        } else if (block.type === "text" && typeof block.text === "string" && block.text.trim() && !msg.parent_tool_use_id) {
          out.lastAssistantText = block.text;
        }
      }
    } else if (msg.type === "result") {
      out.done = true;
      if (typeof msg.session_id === "string") out.sessionId = msg.session_id;
      out.report = msg.structured_output;
      out.resultText = msg.result;
      out.costUsd = msg.total_cost_usd;
      out.durationMs = msg.duration_ms;
      out.numTurns = msg.num_turns;
      out.isError = msg.is_error;
    }
  }
  return out;
}

// What an agent did, in order: its tool calls in short form (its latest message is in StreamSummary). Steps of
// its subagents are marked, as they run beside the main conversation.
export interface StreamStep {
  tool: string;
  text: string; // the call in short form
  subagent?: boolean;
}

export function streamSteps(text: string): StreamStep[] {
  const steps: StreamStep[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // a line still being written
    }
    if (msg?.type !== "assistant" || !Array.isArray(msg.message?.content)) continue;
    const subagent = typeof msg.parent_tool_use_id === "string" ? { subagent: true } : {};
    for (const block of msg.message.content as (ContentBlock & { input?: Record<string, unknown> })[]) {
      if (block.type === "tool_use" && typeof block.name === "string") {
        steps.push({ tool: block.name, text: toolCallText(block.name, block.input ?? {}), ...subagent });
      }
    }
  }
  return steps;
}

// Bash: the command's first line; file tools: the path; Grep and Glob: the pattern; Agent: its description.
export function toolCallText(name: string, input: Record<string, unknown>): string {
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : undefined);
  switch (name) {
    case "Bash":
      return str("command")?.split("\n")[0] ?? "";
    case "Read":
    case "Edit":
    case "MultiEdit":
    case "Write":
      return str("file_path") ?? "";
    case "NotebookEdit":
      return str("notebook_path") ?? "";
    case "Grep":
    case "Glob":
      return str("pattern") ?? "";
    case "Agent":
    case "Task":
      return str("description") ?? "";
    case "WebFetch":
      return str("url") ?? "";
    case "WebSearch":
      return str("query") ?? "";
    case "StructuredOutput":
      return "the report";
    default:
      return "";
  }
}

// ---------------------------------------------------------------------------
// Report validation: the subset of JSON Schema that schemas/*.json use.

export interface JsonSchema {
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: unknown[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  description?: string;
}

// Returns one "path: problem" string per error; empty when the value is valid.
export function validateReport(schema: JsonSchema, value: unknown, path = "$"): string[] {
  const errors: string[] = [];
  if (schema.anyOf) {
    // For a union keyed on a single-value enum such as "cmd", the errors of the branch with that cmd are the
    // useful ones. Otherwise, report the branch with the fewest errors.
    const keyed = schema.anyOf.filter((b) => discriminatorMatches(b, value));
    let best: string[] | undefined;
    for (const branch of keyed.length ? keyed : schema.anyOf) {
      const e = validateReport(branch, value, path);
      if (!e.length) return [];
      if (!best || e.length < best.length) best = e;
    }
    return best ?? [];
  }
  if (schema.type && !hasType(schema.type, value)) {
    return [`${path}: expected ${schema.type}, got ${describe(value)}`];
  }
  if (schema.enum && !schema.enum.some((v) => v === value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`);
  }
  if (schema.type === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(obj, key)) errors.push(`${path}.${key}: required`);
    }
    for (const [key, v] of Object.entries(obj)) {
      const sub = schema.properties?.[key];
      if (sub) errors.push(...validateReport(sub, v, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: unexpected property`);
    }
  }
  if (schema.type === "array" && schema.items) {
    (value as unknown[]).forEach((v, i) => errors.push(...validateReport(schema.items!, v, `${path}[${i}]`)));
  }
  return errors;
}

function discriminatorMatches(branch: JsonSchema, value: unknown): boolean {
  if (!hasType("object", value)) return false;
  const consts = Object.entries(branch.properties ?? {}).filter(([, s]) => s.enum?.length === 1);
  return consts.length > 0 && consts.every(([k, s]) => (value as Record<string, unknown>)[k] === s.enum![0]);
}

function hasType(type: NonNullable<JsonSchema["type"]>, value: unknown): boolean {
  switch (type) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    default:
      return typeof value === type;
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// ---------------------------------------------------------------------------
// Feedback

export function appendFeedback(stateDir: string, jobId: JobId, feedback: Feedback[], now = new Date()): void {
  const dir = join(stateDir, "feedback");
  mkdirSync(dir, { recursive: true });
  // The target becomes a file name and comes from an agent: check them all before writing anything.
  const bad = feedback.find((f) => !/^[a-z0-9-]+$/.test(f.target));
  if (bad) throw new Error(`invalid feedback target: ${JSON.stringify(bad.target)}`);
  for (const f of feedback) {
    appendFileSync(join(dir, `${f.target}.md`), `## ${now.toISOString()} — job ${jobId}\n\n${f.text.trim()}\n\n`);
  }
}

// ---------------------------------------------------------------------------
// Transcripts

// Claude Code names the project directory after the cwd with every character other than an ASCII letter or digit
// replaced by "-" (checked against ~/.claude/projects: "/build/worktrees/test_2_conformance2__extensions__x" is
// "-build-worktrees-test-2-conformance2--extensions--x").
export function transcriptPath(homeDir: string, cwd: string, sessionId: string): string {
  return join(homeDir, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`);
}
