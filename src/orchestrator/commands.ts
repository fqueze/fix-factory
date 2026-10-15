// What each command does, as effects the loop carries out. Pure. Jobs a command starts skip the
// caps: you asked for them. Recovery commands come from an approved plan and run exactly as written.
import { isDeepStrictEqual } from "node:util";
import type { EventInput } from "../state/events.ts";
import type { Command, FactoryConfig, ItemId, JobId, PlannedCommand, RequestId, RequestState } from "../types.ts";
import { ANNOTATIONS_ITEM, authorJobsOf, CANCELLED, itemEpochOf, resumeAuthorPlan } from "./next.ts";
import { requestDir, sessionIdFor, slug, type JobPlan } from "./plan.ts";
import type { View } from "./view.ts";

// An event of this command's request, without repeating the request.
type RequestEvent = EventInput extends infer E ? (E extends unknown ? Omit<E, "request"> : never) : never;

export type Effect =
  | { type: "event"; event: EventInput }
  | { type: "start"; plan: JobPlan }
  | { type: "cancel"; job: JobId; request: RequestId; detail: string } // then job-finished with error CANCELLED
  | { type: "start-now"; request: RequestId };

export interface CommandContext {
  config: FactoryConfig;
  state?: RequestState; // the command's request
  view?: View;
  exists: (request: RequestId) => boolean;
  plan: (job: JobId) => JobPlan | undefined; // jobs/<job>/plan.json, what the runner started
  unroutable?: RequestState[]; // for a global tell-factory: open requests whose route-request failed twice
}

// r-20261015-<slug>, from the first words of the text.
export function newRequestId(c: { t: string; text: string }, exists: (id: RequestId) => boolean): RequestId {
  const day = c.t.slice(0, 10).replace(/-/g, "");
  const name = slug(c.text.split("\n")[0].split(/\s+/).slice(0, 4).join("-")).toLowerCase() || "request";
  const base = `r-${day}-${name}`;
  let id = base;
  for (let n = 2; exists(id); n++) id = `${base}-${n}`;
  return id;
}

export function commandEffects(c: Command, ctx: CommandContext): Effect[] {
  const effects: Effect[] = [];
  const s = ctx.state;
  const view = ctx.view;
  const ev = (event: RequestEvent) => effects.push({ type: "event", event: { ...event, request: s!.id } as EventInput });
  const done = (ok: boolean, detail?: string) => ev({ type: "command-executed", command: c.id, ok, ...(detail ? { detail: detail.slice(0, 500) } : {}) });
  const resume = (item: ItemId, reason: string, message: string): string | undefined => {
    const plan = resumeAuthorPlan(s!.id, view!, item, reason, { message }, "investigating");
    if (plan === undefined) return `${item} has no author session to resume`;
    if (plan === "busy") return `the author of ${item} is running: send it again when it's done`;
    plan.purpose.key = `author:${item}${itemEpochOf(view!, item)}:${reason.replace(/\s+/g, "-")}:${c.id}`;
    effects.push({ type: "start", plan });
    return undefined;
  };

  switch (c.cmd) {
    case "presence":
      return effects; // the loop tracks presence from the commands themselves
    case "tell-factory":
      if (c.request === undefined) {
        // The global box: a request of its own, which route-request makes a new one or forwards.
        const request = newRequestId(c, ctx.exists);
        effects.push({ type: "event", event: { type: "request-created", request, kind: "unrouted", text: c.text, command: c.id } });
        // Text route-request couldn't make sense of asks you to rephrase it: this is the rephrasing.
        for (const old of ctx.unroutable ?? []) {
          const at = (e: RequestEvent): Effect => ({ type: "event", event: { ...e, request: old.id } as EventInput });
          effects.push(at({ type: "request-superseded", by: request }), at({ type: "note", text: `Superseded by ${request}.` }));
          for (const n of old.needsUser) effects.push(at({ type: "user-done", key: n.key }));
          effects.push(at({ type: "step", step: "done" }));
        }
        return effects;
      }
      if (!s) return effects;
      effects.push({
        type: "start",
        plan: {
          purpose: { key: `recover:${c.id}`, what: "recover", reason: c.text.slice(0, 1000) },
          kind: "agent",
          name: "recover",
          cwd: ctx.config.stateDir,
          agent: { sessionId: sessionIdFor(s.id, `recover:${c.id}`), resume: false, vars: { text: c.text, id: s.id, stateDir: requestDir(ctx.config, s.id) } },
        },
      });
      done(true);
      return effects;
  }
  if (!s || !view) return effects;

  // A command from a recovery plan answers that plan's ⚑.
  if (PLANNED.has(c.cmd)) {
    const fields = Object.fromEntries(Object.entries(c).filter(([k]) => !["v", "id", "t", "request"].includes(k)));
    for (const p of s.recoveryPlans) {
      if (p.plan.some((entry) => isDeepStrictEqual(entry, fields)) && s.needsUser.some((n) => n.key === `recovery:${p.job}`)) ev({ type: "user-done", key: `recovery:${p.job}` });
    }
  }
  // Changing an item's state by hand answers its failed:<job> ⚑.
  if ((c.cmd === "set-state" || c.cmd === "redo-step") && c.item) {
    for (const n of s.needsUser.filter((x) => x.key.startsWith("failed:") && x.item === c.item)) ev({ type: "user-done", key: n.key });
  }

  switch (c.cmd) {
    case "approve-push":
      ev({ type: "user-done", key: `approve-push:${c.push}` });
      done(true);
      break;
    case "set-bug":
      if (c.patch === "meta") {
        ev({ type: "meta-bug", bug: c.bug, ...(s.metaBug?.draft ? { draft: s.metaBug.draft } : {}) });
        for (const n of s.needsUser.filter((x) => x.key.startsWith("meta-bug:"))) ev({ type: "user-done", key: n.key });
      } else {
        const { deps: _d, review: _r, replyDrafts: _rd, id, ...p } = s.patches[c.patch];
        ev({ type: "patch", patch: id, ...p, bug: c.bug });
        for (const n of s.needsUser.filter((x) => x.key.startsWith("file-bug:") && x.patch === c.patch)) ev({ type: "user-done", key: n.key });
      }
      done(true);
      break;
    case "comment-bug-draft": {
      const draft = c.patch === "meta" ? s.metaBug?.draft : s.patches[c.patch]?.bugDraft;
      if (!draft) {
        done(false, "no draft to revise");
        break;
      }
      effects.push({
        type: "start",
        plan: {
          purpose: { key: `revise-draft:${c.patch}:${c.id}`, what: "revise-draft", patch: c.patch },
          kind: "agent",
          name: "revise-bug-draft",
          cwd: requestDir(ctx.config, s.id),
          agent: { sessionId: sessionIdFor(s.id, `revise-draft:${c.patch}:${c.id}`), resume: false, vars: { draft: JSON.stringify(draft, null, 2), comments: c.text } },
        },
      });
      done(true);
      break;
    }
    case "stack-comments": {
      const byItem = new Map<ItemId, string[]>();
      for (const x of c.comments) {
        const item = s.patches[x.patch]?.item;
        if (item) byItem.set(item, [...(byItem.get(item) ?? []), `- On ${s.patches[x.patch].title}: ${x.text}`]);
      }
      const errors = [...byItem].map(([item, lines]) => resume(item, "stack comments", `Review comments on your patch, from stack-viewer:\n${lines.join("\n")}\n\nAddress them by amending your commit, then end with the JSON report again.`)).filter((e) => e);
      done(errors.length === 0, errors.join("; "));
      break;
    }
    case "comment-fix": {
      const item = s.patches[c.patch]?.item;
      const error = item ? resume(item, "comment", `A comment on your fix:\n${c.text}\n\nAddress it by amending your commit, then end with the JSON report again.`) : `${c.patch} has no item`;
      done(!error, error);
      break;
    }
    case "take-it":
      ev({ type: "user-done", key: `take-it:${c.item}` });
      done(true);
      break;
    case "hand-back":
      ev({ type: "item-state", item: c.item, state: "handed back" });
      ev({ type: "user-done", key: `take-it:${c.item}` });
      done(true);
      break;
    case "reply-recovery": {
      const job = view.jobs.find((j) => j.job === c.job);
      if (!job?.sessionId) {
        done(false, `no recover session for ${c.job}`);
        break;
      }
      effects.push({
        type: "start",
        plan: {
          purpose: { key: `recover:${c.id}`, what: "recover", reason: c.text.slice(0, 1000), replyTo: c.job },
          kind: "agent",
          name: "recover",
          cwd: job.cwd,
          agent: { sessionId: job.sessionId, resume: true, message: `The user replies: ${c.text}\n\nReturn a revised plan.` },
        },
      });
      done(true);
      break;
    }
    case "start-now":
      effects.push({ type: "start-now", request: s.id });
      done(true);
      break;
    case "retry-job": {
      const job = view.jobs.find((j) => j.job === c.job);
      const saved = ctx.plan(c.job);
      if (!job || !saved) {
        done(false, `unknown job ${c.job}`);
        break;
      }
      if (job.sessionId && view.jobs.some((j) => j.sessionId === job.sessionId && !j.end)) {
        done(false, `the session of ${c.job} is running: retry it once it's done`);
        break;
      }
      // The same plan through the same path, so a dry run still adds --dry-run (or refuses).
      const plan: JobPlan =
        job.kind === "agent" && job.sessionId
          ? { purpose: { ...job.purpose }, kind: "agent", name: job.name, item: job.item, cwd: job.cwd, agent: { sessionId: job.sessionId, resume: true, message: "Try again: continue where you stopped, then end with the JSON report." } }
          : { ...saved, purpose: { ...job.purpose } };
      effects.push({ type: "start", plan });
      ev({ type: "user-done", key: `failed:${c.job}` });
      done(true, c.reason);
      break;
    }
    case "cancel-job":
      effects.push({ type: "cancel", job: c.job, request: s.id, detail: CANCELLED });
      done(true, c.reason);
      break;
    case "resume-agent": {
      const error = resume(c.item, "recovery", c.message);
      done(!error, error ?? c.reason);
      break;
    }
    case "start-agent": {
      const item = s.items[c.item];
      const session = authorJobsOf(view, c.item).find((j) => j.purpose.reason === "initial");
      if (!item || !session || c.prompt !== session.name || c.item === ANNOTATIONS_ITEM) {
        done(false, `start-agent only starts a new ${session?.name ?? "investigate-and-fix"} on an item that already had one`);
        break;
      }
      // A fresh session in the same worktree, with the first run's inputs plus what you said.
      const key = `author:${c.item}${itemEpochOf(view, c.item)}:start:${c.id}`;
      effects.push({
        type: "start",
        plan: {
          purpose: { key, what: "author", item: c.item, reason: "start" },
          kind: "agent",
          name: c.prompt,
          item: c.item,
          cwd: session.cwd,
          agent: { sessionId: sessionIdFor(s.id, key), resume: false, vars: { ...startVars(item.group.tests, session.cwd), failureSummary: `"${item.group.message}" on ${item.group.configs.length} configs. Note from the factory: ${c.reason}` } },
          startEvents: [{ type: "item-state", request: s.id, item: c.item, state: "investigating", detail: "started again" }],
        },
      });
      done(true, c.reason);
      break;
    }
    case "set-state":
      ev({ type: "item-state", item: c.item, state: c.state, detail: c.reason.slice(0, 300) });
      done(true);
      break;
    case "redo-step":
      if (c.item) ev({ type: "item-state", item: c.item, state: "not started", detail: c.reason.slice(0, 300) });
      else ev({ type: "step", step: c.step });
      done(true, c.reason);
      break;
    case "edit-config":
      ev({ type: "config-set", config: { ...s.config, ...c.config } });
      done(true, c.reason);
      break;
    case "shell":
      effects.push({ type: "start", plan: { purpose: { key: `shell:${c.id}`, what: "shell" }, kind: "script", name: "shell", cwd: c.cwd, cmd: ["sh", "-c", c.command] } });
      done(true, c.reason);
      break;
  }
  return effects;
}

const PLANNED = new Set<string>(["retry-job", "cancel-job", "resume-agent", "start-agent", "set-state", "redo-step", "edit-config", "shell"] satisfies PlannedCommand["cmd"][]);

function startVars(tests: string[], worktree: string): Record<string, string> {
  return { test: tests.length > 1 ? `${tests[0]} (and ${tests.length - 1} other tests)` : tests[0], worktree };
}
