// Mechanical checks on text the factory produces. No judgement: format, length and banned patterns.
//
//   node src/cli/lint-text.ts --kind commit|bug|reply <file or ->
//     → {ok, violations: [{rule, line?, text}]}
//     commit: the full commit message. bug: a BugDraft as JSON. reply: a review reply.
//     line is 1-based within the commit message, the bug description or the reply. Exit code 0 even when
//     ok is false.
//
// Rules come from ~/.claude/skills/commit-message/SKILL.md and the verification greps of
// CLEANUP_COMMIT_MESSAGES.md. Those greps look for a shape, not a closed set of phrasings, so a clean
// result here doesn't mean the message is good.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { BugDraft } from "../types.ts";

export interface Violation {
  rule: string;
  line?: number;
  text: string;
}

export interface LintResult {
  ok: boolean;
  violations: Violation[];
}

type Rule = (lines: string[]) => Violation[];

export const BODY_MAX_LINES = 8;
export const SUMMARY_MAX = 150;
export const REPLY_MAX_CHARS = 800;

const TRAILER = /^(Differential Revision|Depends on D\d+)\b/;

function matching(rule: string, lines: string[], re: RegExp, from = 0): Violation[] {
  const out: Violation[] = [];
  lines.forEach((l, i) => {
    if (i >= from && re.test(l)) out.push({ rule, line: i + 1, text: l.trim() });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Commit message rules. Each takes the message split into lines.

// The description can't contain ", r=", so a second "r=" can't hide in it.
const FIRST_LINE = /^Bug (\d+|XXXXXXX) - \S(?:(?!, r=).)*, r=([^\s,=]+(?:,\s*[^\s,=]+)*)\.$/;

export const firstLineFormat: Rule = (lines) =>
  FIRST_LINE.test(lines[0] ?? "") ? [] : [{ rule: "firstLineFormat", line: 1, text: `expected "Bug N - <text>, r=<reviewers>.": ${lines[0] ?? ""}` }];

export const reviewerNotRequest: Rule = (lines) => matching("reviewerNotRequest", lines.slice(0, 1), /\br\?/);

// A reviewer group name without "#" is read as a user name by moz-phab.
export const reviewerGroupHash: Rule = (lines) => {
  const m = FIRST_LINE.exec(lines[0] ?? "");
  if (!m) return [];
  return m[2]
    .split(/,\s*/)
    .filter((r) => !r.startsWith("#") && /reviewers/.test(r))
    .map((r) => ({ rule: "reviewerGroupHash", line: 1, text: `group ${r} needs a "#": #${r.replace(/!$/, "")}` }));
};

export const blankSecondLine: Rule = (lines) =>
  lines.length > 1 && lines[1].trim() !== "" ? [{ rule: "blankSecondLine", line: 2, text: lines[1] }] : [];

export const bodyLength: Rule = (lines) => {
  const body = lines.slice(1).filter((l) => l.trim() !== "" && !TRAILER.test(l));
  return body.length > BODY_MAX_LINES ? [{ rule: "bodyLength", text: `body has ${body.length} lines, max ${BODY_MAX_LINES}` }] : [];
};

const CODE_EXT = "c|cc|cpp|h|hh|hpp|m|mm|js|mjs|jsm|sys\\.mjs|ts|tsx|jsx|py|rs|java|kt|toml|ini|html|xhtml|css|webidl|ipdl|yaml|yml|json|ftl|sh|build";
const FILE_LINE = new RegExp(`[\\w./-]+\\.(?:${CODE_EXT}):\\d+`);

export const noFileLineRefs: Rule = (lines) => matching("noFileLineRefs", lines, FILE_LINE);

export const noTryLinks: Rule = (lines) => matching("noTryLinks", lines, /https?:\/\/\S*(treeherder\.mozilla\.org|taskcluster|firefox-ci-tc|hg\.mozilla\.org\/try)/i);

export const noMeasurements: Rule = (lines) => matching("noMeasurements", lines, /\d+%|\b\d+\/\d+\b|\bout of \d+/i);

// Things the patch does not do: scope disclaimers, notes to self, hedging, recorded counter-evidence.
export const HEDGING = [
  "not addressed",
  "does not do",
  "doesn't do",
  "does not show",
  "doesn't show",
  "rather than buried",
  "stated rather",
  "worth recording",
  "worth stating",
  "recorded against",
  "points the other way",
  "on that basis",
  "if this returns",
  "this patch does not",
  "this patch doesn't",
];

export const noHedging: Rule = (lines) => matching("noHedging", lines, new RegExp(HEDGING.join("|"), "i"));

// Mechanisms stated as established fact, and who should fix the rest.
export const CAUSE_CLAIMS = ["root cause", "belongs in", "the cause is", "marks a run", "rather than noise", "does not reuse", "deviates"];

export const noCauseClaims: Rule = (lines) => matching("noCauseClaims", lines, new RegExp(CAUSE_CLAIMS.join("|"), "i"));

export const noStackCrossRefs: Rule = (lines) =>
  matching("noStackCrossRefs", lines, /\b(previous|next) patch\b|\bthis (series|stack)\b/i);

export const noAiAttribution: Rule = (lines) =>
  matching("noAiAttribution", lines, /co-authored-by|generated (with|by) .*(claude|ai\b|gpt)|noreply@anthropic\.com|\u{1F916}/iu);

export const COMMIT_RULES: Rule[] = [
  firstLineFormat,
  reviewerNotRequest,
  reviewerGroupHash,
  blankSecondLine,
  bodyLength,
  noFileLineRefs,
  noTryLinks,
  noMeasurements,
  noHedging,
  noCauseClaims,
  noStackCrossRefs,
  noAiAttribution,
];

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
}

function result(violations: Violation[]): LintResult {
  return { ok: violations.length === 0, violations };
}

export function lintCommit(message: string): LintResult {
  const lines = splitLines(message);
  return result(COMMIT_RULES.flatMap((r) => r(lines)));
}

// ---------------------------------------------------------------------------
// Bug drafts.

export function requiredFields(draft: Partial<BugDraft>): Violation[] {
  return (["product", "component", "summary", "description"] as const)
    .filter((f) => typeof draft[f] !== "string" || draft[f]!.trim() === "")
    .map((f) => ({ rule: "requiredFields", text: `missing ${f}` }));
}

export function summaryLength(summary: string): Violation[] {
  return summary.length > SUMMARY_MAX ? [{ rule: "summaryLength", text: `summary has ${summary.length} characters, max ${SUMMARY_MAX}` }] : [];
}

export function descriptionLength(description: string): Violation[] {
  const n = splitLines(description).filter((l) => l.trim() !== "").length;
  return n > BODY_MAX_LINES ? [{ rule: "descriptionLength", text: `description has ${n} lines, max ${BODY_MAX_LINES}` }] : [];
}

export function lintBug(draft: Partial<BugDraft>): LintResult {
  const description = draft.description ?? "";
  return result([
    ...requiredFields(draft),
    ...summaryLength(draft.summary ?? ""),
    ...descriptionLength(description),
    ...noAiAttribution([draft.summary ?? "", ...splitLines(description)]),
  ]);
}

// ---------------------------------------------------------------------------
// Review replies.

export function replyLength(text: string): Violation[] {
  const n = text.trim().length;
  return n > REPLY_MAX_CHARS ? [{ rule: "replyLength", text: `reply has ${n} characters, max ${REPLY_MAX_CHARS}` }] : [];
}

export function lintReply(text: string): LintResult {
  const empty = text.trim() === "" ? [{ rule: "replyLength", text: "empty reply" }] : [];
  return result([...empty, ...replyLength(text), ...noAiAttribution(splitLines(text))]);
}

export function lint(kind: string, text: string): LintResult {
  switch (kind) {
    case "commit":
      return lintCommit(text);
    case "bug":
      return lintBug(JSON.parse(text) as Partial<BugDraft>);
    case "reply":
      return lintReply(text);
    default:
      throw new Error(`unknown kind: ${kind}`);
  }
}

// No subcommand here, so this doesn't go through runCli; same output and exit code conventions.
function main() {
  let kind: string | undefined;
  let file: string | undefined;
  try {
    const { values, positionals } = parseArgs({ options: { kind: { type: "string" } }, allowPositionals: true });
    kind = values.kind;
    file = positionals[0];
    if (!["commit", "bug", "reply"].includes(kind ?? "") || positionals.length !== 1) throw new Error();
  } catch {
    process.stderr.write("usage: lint-text.ts --kind commit|bug|reply <file or ->\n");
    process.exitCode = 2;
    return;
  }
  try {
    const text = readFileSync(file === "-" ? 0 : file!, "utf8");
    process.stdout.write(JSON.stringify(lint(kind!, text)) + "\n");
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) + "\n");
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main();
}
