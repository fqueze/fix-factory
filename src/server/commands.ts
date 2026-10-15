import { isDeepStrictEqual } from "node:util";
import type { Command, ItemState, PlannedCommand, RequestKind, RequestState, RequestStep } from "../types.ts";
import type { CommandInput } from "../state/commands.ts";

export const ITEM_STATES = [
  "not started",
  "waiting for a build slot",
  "investigating",
  "fix verified locally",
  "in critical review",
  "review findings",
  "reviewed",
  "in stack",
  "in try",
  "waiting for review",
  "addressing review comments",
  "blocked",
  "fixed",
  "left as-is",
  "handed back",
  "landed",
] as const satisfies readonly ItemState[];

export const REQUEST_STEPS = [
  "request",
  "first signal",
  "work list",
  "investigate and fix",
  "stack",
  "verify on try",
  "meta bug",
  "submit",
  "review comments",
  "landing",
  "done",
] as const satisfies readonly RequestStep[];

const REQUEST_KINDS = ["burndown", "try-push"] as const satisfies readonly RequestKind[];

// Compile-time checks that the lists above cover their unions.
type Missing<U, L extends readonly unknown[]> = Exclude<U, L[number]>;
const allItemStates: Missing<ItemState, typeof ITEM_STATES> extends never ? true : false = true;
const allSteps: Missing<RequestStep, typeof REQUEST_STEPS> extends never ? true : false = true;
void allItemStates;
void allSteps;

type Field =
  | "string"
  | "string?"
  | "any-string"
  | "int"
  | "boolean"
  | "string[]"
  | "object"
  | "comments"
  | { oneOf: readonly string[]; optional?: boolean };

// One entry per Command["cmd"]: the type checker fails here when a command is added
// to src/types.ts without being added to the page's validation.
const SPECS: Record<Command["cmd"], Record<string, Field>> = {
  "new-request": { kind: { oneOf: REQUEST_KINDS }, text: "any-string", folder: "string?", rev: "string?" },
  "approve-push": { push: "string" },
  presence: { visible: "boolean" },
  "set-bug": { patch: "string", bug: "int" },
  "comment-bug-draft": { patch: "string", text: "string" },
  "stack-comments": { stack: "string", comments: "comments" },
  "take-it": { item: "string" },
  "hand-back": { item: "string" },
  "comment-fix": { patch: "string", text: "string" },
  "tell-factory": { text: "string" },
  "reply-recovery": { job: "string", text: "string" },
  "start-now": {},
  "retry-job": { job: "string", reason: "string" },
  "cancel-job": { job: "string", reason: "string" },
  "resume-agent": { item: "string", message: "string", reason: "string" },
  "start-agent": { item: "string", prompt: "string", reason: "string" },
  "set-state": { item: "string", state: { oneOf: ITEM_STATES }, reason: "string" },
  "redo-step": { item: "string?", step: { oneOf: REQUEST_STEPS }, reason: "string" },
  "edit-config": { config: "object", reason: "string" },
  shell: { cwd: "string", command: "string", reason: "string" },
};

// Commands that only make sense about a request.
const NEEDS_REQUEST = new Set<string>(["approve-push", "set-bug", "comment-bug-draft", "stack-comments", "take-it", "hand-back", "comment-fix", "reply-recovery", "start-now"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkField(name: string, spec: Field, value: unknown): string | null {
  if (typeof spec === "object") {
    if (value === undefined && spec.optional) {
      return null;
    }
    return typeof value === "string" && spec.oneOf.includes(value) ? null : `${name} must be one of: ${spec.oneOf.join(", ")}`;
  }
  switch (spec) {
    case "string?":
      return value === undefined || typeof value === "string" ? null : `${name} must be a string`;
    case "any-string":
      return typeof value === "string" ? null : `${name} must be a string`;
    case "string":
      return typeof value === "string" && value.trim() !== "" ? null : `${name} must be a non-empty string`;
    case "int":
      return Number.isSafeInteger(value) && (value as number) > 0 ? null : `${name} must be a positive integer`;
    case "boolean":
      return typeof value === "boolean" ? null : `${name} must be true or false`;
    case "string[]":
      return Array.isArray(value) && value.every((v) => typeof v === "string") ? null : `${name} must be a list of strings`;
    case "object":
      return isObject(value) ? null : `${name} must be an object`;
    case "comments":
      return Array.isArray(value) && value.length > 0 && value.every((c) => isObject(c) && typeof c.patch === "string" && typeof c.text === "string" && c.text.trim() !== "")
        ? null
        : `${name} must be a non-empty list of {patch, text}`;
  }
}

export type Validation = { ok: true; command: CommandInput } | { ok: false; error: string };

// Checks one command against the Command union, and the ids it names against the
// request's state when it's about a request. Unknown fields are dropped.
export function validateCommand(input: unknown, getRequest: (id: string) => RequestState | undefined): Validation {
  if (!isObject(input)) {
    return { ok: false, error: "a command must be a JSON object" };
  }
  const cmd = input.cmd;
  if (typeof cmd !== "string" || !Object.hasOwn(SPECS, cmd)) {
    return { ok: false, error: `unknown command: ${String(cmd)}` };
  }
  const spec = SPECS[cmd as Command["cmd"]];
  const out: Record<string, unknown> = { cmd };
  for (const [name, field] of Object.entries(spec)) {
    const error = checkField(name, field, input[name]);
    if (error) {
      return { ok: false, error: `${cmd}: ${error}` };
    }
    if (input[name] !== undefined) {
      out[name] = input[name];
    }
  }

  if (cmd === "new-request" && !(out.kind === "burndown" ? out.folder : out.rev)) {
    return { ok: false, error: out.kind === "burndown" ? "a burndown needs a folder" : "a try-push request needs a revision" };
  }

  if (input.request !== undefined) {
    if (typeof input.request !== "string") {
      return { ok: false, error: "request must be a string" };
    }
    out.request = input.request;
  }
  if ((NEEDS_REQUEST.has(cmd) || PLANNED.has(cmd)) && out.request === undefined) {
    return { ok: false, error: `${cmd} needs a request` };
  }
  if (typeof out.request === "string") {
    const state = getRequest(out.request);
    if (!state) {
      return { ok: false, error: `unknown request: ${out.request}` };
    }
    const error = checkIds(out, state);
    if (error) {
      return { ok: false, error: `${cmd}: ${error}` };
    }
    // Recovery commands (shell among them) only run as approved from a plan the
    // request already has: the checkboxes send its entries unchanged.
    if (PLANNED.has(cmd) && !state.recoveryPlans.some((p) => p.plan.some((entry) => isDeepStrictEqual(project(entry, spec), project(out, spec))))) {
      return { ok: false, error: `${cmd}: not in a recovery plan of ${out.request}` };
    }
  }
  return { ok: true, command: out as unknown as CommandInput };
}

const PLANNED = new Set<string>(["retry-job", "cancel-job", "resume-agent", "start-agent", "set-state", "redo-step", "edit-config", "shell"] satisfies PlannedCommand["cmd"][]);

function project(c: object, spec: Record<string, Field>): Record<string, unknown> {
  const o = c as Record<string, unknown>;
  return Object.fromEntries(["cmd", ...Object.keys(spec)].filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
}

function checkIds(c: Record<string, unknown>, state: RequestState): string | null {
  const patchOk = (p: unknown) => p === "meta" || (typeof p === "string" && Object.hasOwn(state.patches, p));
  if (typeof c.push === "string" && !Object.hasOwn(state.pushes, c.push)) {
    return `unknown push ${c.push}`;
  }
  if (c.patch !== undefined && !patchOk(c.patch)) {
    return `unknown patch ${String(c.patch)}`;
  }
  if (typeof c.item === "string" && !Object.hasOwn(state.items, c.item)) {
    return `unknown item ${c.item}`;
  }
  if (typeof c.job === "string" && !Object.hasOwn(state.jobs, c.job)) {
    return `unknown job ${c.job}`;
  }
  if (typeof c.stack === "string" && !Object.hasOwn(state.stacks, c.stack)) {
    return `unknown stack ${c.stack}`;
  }
  if (Array.isArray(c.comments)) {
    const bad = (c.comments as { patch: string }[]).find((x) => !patchOk(x.patch));
    if (bad) {
      return `unknown patch ${bad.patch}`;
    }
  }
  return null;
}

// "2081216", "Bug 2081216", or a bug URL ending in id=2081216.
export function parseBugNumber(text: string): number | null {
  const m = text.trim().match(/^(?:bug\s*)?(\d{4,8})$/i) ?? text.trim().match(/^https?:\/\/\S*[?&/]id=(\d{4,8})\b\S*$/) ?? text.trim().match(/^https?:\/\/bugzil\.la\/(\d{4,8})$/);
  return m ? Number(m[1]) : null;
}

// HTML forms post `command` fields holding the JSON of each command (several for
// "Approve both", one per checked box for a recovery plan), plus what was typed:
// `text` fills each command's text field; `bugOrText` turns a {cmd: "set-bug"}
// template into a comment-bug-draft when what was typed isn't a bug number.
export function commandsFromForm(form: URLSearchParams): unknown[] {
  const text = form.get("text");
  const bugOrText = form.get("bugOrText");
  return form.getAll("command").map((json) => {
    let c: unknown;
    try {
      c = JSON.parse(json);
    } catch {
      return json;
    }
    if (!isObject(c)) {
      return c;
    }
    if (text !== null) {
      c.text = text;
    }
    if (bugOrText !== null && c.cmd === "set-bug") {
      const bug = parseBugNumber(bugOrText);
      return bug === null ? { cmd: "comment-bug-draft", request: c.request, patch: c.patch, text: bugOrText } : { ...c, bug };
    }
    return c;
  });
}
