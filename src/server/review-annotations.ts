// The annotations file stack-viewer gets with --annotations (the contract is md-viewer's README): for each commit of
// the page, its review status, what you can do on it (approve, give its bug's number), its bug to file linked from its
// title, its test plan, and the comments made on it before: yours, its Phabricator reviewers' (with the factory's
// draft replies) and the critical reviews' findings. An earlier comment was made on an earlier version of the patch:
// its line is carried to this version through the diff between the two, and it's outdated when that line changed.
import { spawnSync } from "node:child_process";
import { REVIEW_STATUS_LABELS, REVIEW_STATUS_TOOLTIPS, reviewStatus, type Fingerprint } from "../state/approval.ts";
import { patchFindings } from "../state/findings.ts";
import { isAnswered } from "../state/landing.ts";
import { sameBugDraft } from "../state/meta-bug.ts";
import type { BugDraft, JobId, PatchId, PatchView, RequestState, ReviewAnchor, ReviewResponse } from "../types.ts";
import { hasBug, phabUrl } from "./pages/common.ts";

export interface AnnotationComment {
  id: string;
  anchor: ReviewAnchor;
  author: string;
  date?: string;
  body: string;
  sourceUrl?: string;
  outdated: boolean;
  draftReply?: string;
  state: "open" | "done" | "addressed" | "ignored";
  responses: ReviewResponse["response"][];
}

export const SEND_LABEL = "Send comments to the factory";

export interface CommitAnnotation {
  draftKey: string; // what stack-viewer keeps your drafts under: the patch, whatever its sha
  status?: { kind: "approved" | "changed" | "unreviewed"; label: string; tooltip: string }; // none once on Phabricator: resubmitted from its interdiff
  sections: { id: string; title: string; markdown: string }[];
  titleLinks: { text: string; href: string; tooltip?: string; label?: string }[];
  actions: ({ id: "approve" | "send"; label: string; kind: "button"; at: "end"; tone?: "positive"; tooltip: string } | { id: "set-bug"; label: string; kind: "input"; placeholder: string; tooltip: string })[];
  comments: AnnotationComment[];
}

export interface Annotations {
  title?: string; // stack-viewer's header in place of the range and the folder
  commits: Record<string, CommitAnnotation>;
}

export interface AnnotationIo {
  git: (args: string[]) => string | undefined; // in the repo; undefined when git fails
  fingerprint: Fingerprint;
  report: (job: JobId) => unknown;
  bugUrl: (draft: BugDraft) => string; // its prefilled enter_bug.cgi
}

// Commits by full sha, each with its patch.
export function buildAnnotations(r: RequestState, commits: Record<string, PatchId>, io: AnnotationIo, title?: string): Annotations {
  const lines = lineMapper(io.git);
  const out: Annotations = { ...(title ? { title } : {}), commits: {} };
  for (const [sha, id] of Object.entries(commits)) out.commits[sha] = commitAnnotation(r, r.patches[id], sha, io, lines);
  return out;
}

export function commitAnnotation(r: RequestState, p: PatchView, sha: string, io: AnnotationIo, lines = lineMapper(io.git)): CommitAnnotation {
  const kind = reviewStatus({ sha, approved: p.approved }, io.fingerprint);
  // Patches sharing a bug draft have it filed once, from the first one (its number goes in each).
  const toFile = !hasBug(p) && p.bugDraft !== undefined && sameBugDraft(r, p.id)[0].id === p.id;
  const placeholder = /\bBug X+\b/.exec(p.title)?.[0];
  const testPlan = p.testPlan ?? p.testPlanSent?.text;
  return {
    // Your unsent comments are kept under it: the patch's commit gets a new sha whenever the stack is rewritten.
    draftKey: `${r.id}:${p.id}`,
    ...(p.revision === undefined ? { status: { kind, label: REVIEW_STATUS_LABELS[kind], tooltip: REVIEW_STATUS_TOOLTIPS[kind] } } : {}),
    sections: testPlan === undefined ? [] : [{ id: "test-plan", title: "Test plan", markdown: testPlan }],
    titleLinks: toFile && placeholder ? [{ text: placeholder, href: io.bugUrl(p.bugDraft!), tooltip: "File its bug: Bugzilla's form, prefilled with the factory's draft. Then give its number in Bug number" }] : [],
    actions: [
      ...(kind === "approved" || p.revision !== undefined ? [] : [{ id: "approve" as const, label: kind === "changed" ? "Approve this version" : "Approve", kind: "button" as const, at: "end" as const, tone: "positive" as const, tooltip: "The moz-phab command is offered once you approved every patch of the stack; a rebase keeps it approved" }]),
      ...(toFile ? [{ id: "set-bug" as const, label: "Bug number", kind: "input" as const, placeholder: "1234567", tooltip: "The bug you filed from the draft (the Bug XXXXXXX link): the factory puts it in the commit message" }] : []),
      { id: "send", label: SEND_LABEL, kind: "button", at: "end", tooltip: "Sends what you wrote and answered on every patch of the page since the last send" },
    ],
    comments: [...yourComments(p, sha, lines), ...phabComments(p, sha, lines), ...findingComments(r, p, sha, io, lines)],
  };
}

type Lines = ReturnType<typeof lineMapper>;

// What happened to a comment since, from what you did to it in stack-viewer.
function responded(p: PatchView, id: string): ReviewResponse["response"] | undefined {
  const x = p.responses?.[id]?.response;
  return x === "reopen" ? undefined : x;
}

function yourComments(p: PatchView, sha: string, lines: Lines): AnnotationComment[] {
  return (p.yourComments ?? []).flatMap((c) => {
    // From before anchors: the text holds one entry per comment, each saying where it is.
    const entries = c.anchor ? [{ id: c.id, anchor: c.anchor, body: c.text }] : parseEntries(c.text).map((e, i, all) => ({ ...e, id: all.length > 1 ? `${c.id}-${i + 1}` : c.id }));
    return entries.map((e) => {
      const moved = lines.carry(e.anchor, c.sha, sha, c.lines, p.testPlan ?? p.testPlanSent?.text);
      return {
        id: e.id,
        anchor: moved ?? e.anchor,
        author: "you",
        date: c.t,
        body: e.body,
        outdated: moved === undefined,
        state: responded(p, e.id) === "done" ? ("done" as const) : ("open" as const),
        responses: ["done", "reply"] as ReviewResponse["response"][],
      };
    });
  });
}

function phabComments(p: PatchView, sha: string, lines: Lines): AnnotationComment[] {
  const review = p.review;
  if (!review) return [];
  // Made on a diff of the revision; the factory knows the commit of its latest one, or of the one it sent.
  const base = review.diff?.commit ?? p.sentSha;
  const drafts = new Map(p.replyDrafts.map((d) => [d.commentId, d.text]));
  return review.comments
    .filter((c) => c.author !== review.author)
    .map((c) => {
      const id = `phab-${c.id}`;
      const anchor: ReviewAnchor = c.file ? { file: c.file, ...(c.line ? { line: c.line } : {}), side: "new" } : { file: "(commit)" };
      const moved = base === undefined ? undefined : lines.carry(anchor, base, sha);
      const r = responded(p, id);
      const draft = drafts.get(c.id);
      return {
        id,
        anchor: moved ?? anchor,
        author: `${c.author} (Phabricator)`,
        body: `${c.kind && c.kind !== "none" ? `*${c.kind}* · ` : ""}${c.text}${c.suggestion ? `\n\nSuggested edit:\n\n\`\`\`\n${c.suggestion}\n\`\`\`` : ""}`,
        sourceUrl: phabUrl(review.revision, c.id),
        outdated: moved === undefined,
        ...(draft !== undefined ? { draftReply: draft } : {}),
        state: c.done ? "done" : r === "ignore" ? "ignored" : r === "address" || isAnswered(p, c) ? "addressed" : "open",
        responses: ["address", "reply", "ignore"],
      };
    });
}

function findingComments(r: RequestState, p: PatchView, sha: string, io: AnnotationIo, lines: Lines): AnnotationComment[] {
  // Landed or abandoned: too late for them.
  if (p.review?.status === "published" || p.review?.status === "abandoned") return [];
  const shas = r.patchShas[p.id] ?? [p.sha];
  return patchFindings(r, p, io.report).map((f) => {
    const anchor: ReviewAnchor = f.file ? { file: f.file, ...(f.line ? { line: f.line } : {}), side: "new" } : { file: "(commit)" };
    const reviewed = f.sha === undefined ? undefined : shas.find((x) => x.startsWith(f.sha!));
    const moved = reviewed === undefined ? (f.file ? undefined : anchor) : lines.carry(anchor, reviewed, sha);
    const x = responded(p, f.id);
    return {
      id: f.id,
      anchor: moved ?? anchor,
      author: f.of === "patch" ? "critical review" : "critical review of the stack",
      date: f.t,
      body: `**${f.severity}**: ${f.text}`,
      outdated: moved === undefined,
      state: x === "ignore" ? "ignored" : x === "address" || f.addressed ? "addressed" : "open",
      responses: ["address", "ignore"],
    };
  });
}

// The entries of a comment-sent text from before anchors, as stack-viewer's mdvReviewEntries wrote them: "- <where> —
// <quote>", the lines quoted in a fenced block, then the comment, indented.
export function parseEntries(text: string): { anchor: ReviewAnchor; body: string }[] {
  const chunks = text.split(/\n(?=- )/).filter((x) => x.trim());
  if (!chunks.length || !chunks.every((x) => x.startsWith("- "))) return [{ anchor: { file: "(commit)" }, body: text }];
  return chunks.map((chunk) => {
    const [head, ...rest] = chunk.split("\n");
    const where = /^- (.*?) — /.exec(head)?.[1] ?? head.slice(2);
    const message = /^the commit message(?:, line (\d+))?$/.exec(where);
    const file = /^(.+?)(?::(\d+))?( \(line number in the original file\))?$/.exec(where)!;
    const anchor: ReviewAnchor = message
      ? { file: "(commit)", ...(message[1] ? { line: Number(message[1]) } : {}) }
      : { file: file[1], ...(file[2] ? { line: Number(file[2]) } : {}), side: file[3] ? "old" : "new" };
    // The comment itself, without the lines it quotes (stack-viewer shows them).
    const body = rest
      .join("\n")
      .replace(/^\s*\n {2}```[^\n]*\n[\s\S]*?\n {2}```\n/, "")
      .split("\n")
      .map((l) => l.replace(/^ {2}/, ""))
      .join("\n")
      .trim();
    return { anchor, body: body || chunk };
  });
}

// Carries an anchor from the commit it was made on to another version of the patch: undefined when its lines aren't
// in that version. Git's answers are cached (commits never change).
export function lineMapper(git: AnnotationIo["git"]) {
  const cache = new Map<string, string | undefined>();
  const run = (args: string[]) => {
    const k = args.join("\0");
    if (!cache.has(k)) cache.set(k, git(args));
    return cache.get(k);
  };
  const files = (sha: string) => new Set((run(["diff", "--name-only", "--no-renames", `${sha}^`, sha]) ?? "").split("\n").filter(Boolean));
  const fileLine = (from: string, to: string, file: string, line: number): number | undefined => {
    if (from === to) return line;
    const diff = run(["diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames", from, to, "--", file]);
    if (diff === undefined || /^deleted file mode/m.test(diff)) return undefined;
    let shift = 0;
    for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/gm)) {
      const start = Number(m[1]);
      const removed = m[2] === undefined ? 1 : Number(m[2]);
      const added = m[3] === undefined ? 1 : Number(m[3]);
      // Lines added after line `start`, none removed.
      if (removed === 0) {
        if (line <= start) break;
        shift += added;
        continue;
      }
      if (line < start) break;
      if (line < start + removed) return undefined;
      shift += added - removed;
    }
    return line + shift;
  };
  // The same lines in another text: where they were, else the one place they are.
  const textLines = (quoted: string[], after: string[], line: number): number | undefined => {
    const at = (i: number) => quoted.every((l, k) => after[i + k] === l);
    if (!quoted.length) return undefined;
    if (at(line - 1)) return line;
    const found = after.map((_, i) => i).filter((i) => at(i));
    return found.length === 1 ? found[0] + 1 : undefined;
  };
  const range = (line: ReviewAnchor["line"]) => (line === undefined ? undefined : typeof line === "number" ? [line, line] : line);
  const withLine = (a: ReviewAnchor, start: number, end: number): ReviewAnchor => ({ ...a, line: start === end ? start : [start, end] });
  return {
    carry(a: ReviewAnchor, from: string, to: string, quoted?: string[], section?: string): ReviewAnchor | undefined {
      const lines = range(a.line);
      if (a.file.startsWith("(section:")) {
        // Sections aren't in git: the lines the comment was on, when it was made, found in this version's text.
        if (!lines || section === undefined) return lines ? undefined : a;
        const start = quoted && textLines(quoted, section.split("\n"), lines[0]);
        return start === undefined ? undefined : withLine(a, start, start + lines[1] - lines[0]);
      }
      if (a.file === "(commit)") {
        if (!lines || from === to) return a;
        const before = run(["log", "-1", "--format=%B", from])?.split("\n");
        const after = run(["log", "-1", "--format=%B", to])?.split("\n");
        if (!before || !after) return undefined;
        const start = textLines(before.slice(lines[0] - 1, lines[1]), after, lines[0]);
        return start === undefined ? undefined : withLine(a, start, start + lines[1] - lines[0]);
      }
      if (!files(to).has(a.file)) return undefined;
      if (!lines) return a;
      const [f, t] = a.side === "old" ? [`${from}^`, `${to}^`] : [from, to];
      const start = fileLine(f, t, a.file, lines[0]);
      const end = fileLine(f, t, a.file, lines[1]);
      return start === undefined || end === undefined ? undefined : withLine(a, start, end);
    },
  };
}

export function gitIn(repo: string): AnnotationIo["git"] {
  return (args) => {
    const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return r.status === 0 ? r.stdout : undefined;
  };
}
