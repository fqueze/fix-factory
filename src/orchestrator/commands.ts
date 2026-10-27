// What each command does, as effects the loop carries out. Pure. Jobs a command starts skip the
// caps: you asked for them. Recovery commands come from an approved plan and run exactly as written.
import { isDeepStrictEqual } from "node:util";
import type { EventInput } from "../state/events.ts";
import { sameBugDraft } from "../state/meta-bug.ts";
import { canDismiss, canRetry, isPushJob, reviewLimitFlag } from "../state/flags.ts";
import type { Command, Event, FactoryConfig, ItemId, JobId, PlannedCommand, RequestId, RequestState } from "../types.ts";
import { ANNOTATIONS_ITEM, authorJobsOf, CANCELLED, itemEpochOf, SETTLED, TERMINAL, resumeAuthorPlan } from "./next.ts";
import { handOffReferences } from "./hand-off.ts";
import { partEvents, splitProblem } from "./split.ts";
import { dataPath, requestDir, sessionIdFor, slug, type JobPlan } from "./plan.ts";
import type { View } from "./view.ts";

// An event of this command's request, without repeating the request.
type RequestEvent = EventInput extends infer E ? (E extends unknown ? Omit<E, "request"> : never) : never;

export type Effect =
  | { type: "event"; event: EventInput }
  | { type: "start"; plan: JobPlan }
  | { type: "cancel"; job: JobId; request: RequestId; detail: string } // then job-finished with error CANCELLED
  | { type: "start-now"; request: RequestId }
  | { type: "allow-push"; sessionId: string } // no-push.ts lets that session make one push
  | { type: "copy-report"; job: JobId; from: RequestId; to: RequestId }; // a split's: its agent's report, if it has one

export interface CommandContext {
  config: FactoryConfig;
  state?: RequestState; // the command's request
  view?: View;
  exists: (request: RequestId) => boolean;
  plan: (job: JobId) => JobPlan | undefined; // jobs/<job>/plan.json, what the runner started
  unroutable?: RequestState[]; // for a global tell-factory: open requests whose route-request failed twice
  events?: (request: RequestId) => Event[]; // a request's events, for split-request
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
  // With the item and job it was about: a refusal stays on the page until one like it succeeds.
  const about = { ...("item" in c && c.item !== undefined ? { item: c.item } : {}), ...("job" in c ? { job: c.job } : {}) };
  const done = (ok: boolean, detail?: string) => ev({ type: "command-executed", command: c.id, cmd: c.cmd, ...about, ok, ...(detail ? { detail: detail.slice(0, 500) } : {}) });
  // Refusals are read on the page: a group by its test, not its id.
  const itemName = (item: ItemId): string => {
    const tests = s!.items[item]?.group.tests ?? [];
    return tests.length === 1 ? tests[0].split("/").pop()! : tests.length > 1 ? `the group of ${tests.length} tests` : "this group";
  };
  const resume = (item: ItemId, reason: string, message: string): string | undefined => {
    const plan = resumeAuthorPlan(s!.id, view!, item, reason, { message }, "investigating");
    if (plan === undefined) return `${itemName(item)} has no author session to resume`;
    if (plan === "busy") return `the author of ${itemName(item)} is running: send it again when it's done`;
    plan.purpose.key = `author:${item}${itemEpochOf(view!, item)}:${reason.replace(/\s+/g, "-")}:${c.id}`;
    effects.push({ type: "start", plan });
    return undefined;
  };
  // The ⚑s that wait on an item's way forward.
  const clearItemFlags = (item: ItemId) => {
    for (const n of s!.needsUser.filter((x) => x.item === item && (x.key.startsWith("failed:") || x.key.startsWith("stopped:")))) ev({ type: "user-done", key: n.key });
  };
  // Keys of the item whose job you stopped: next() may start them again (a stopped lint would otherwise stay
  // stopped when the author comes back with the same commit).
  const reopen = (item: ItemId) => {
    for (const j of view!.jobs.filter((x) => x.item === item && x.end?.error?.startsWith(CANCELLED) && !view!.done.has(`reopen:${x.job}`))) ev({ type: "user-done", key: `reopen:${j.job}` });
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

  // Telling the skip-ifs' author what to do (Keep them, or anything else) answers its question about them.
  if (c.cmd === "continue") {
    for (const n of s.needsUser.filter((x) => x.key.startsWith("keep-skips:") && x.item === c.item)) ev({ type: "user-done", key: n.key });
  }

  switch (c.cmd) {
    case "approve-push":
      ev({ type: "user-done", key: `approve-push:${c.push}` });
      done(true);
      break;
    case "copied-reorg":
      if (!c.key.startsWith("land:")) {
        done(false, `${c.key} isn't a reorg to run`);
        break;
      }
      ev({ type: "user-done", key: c.key, reorg: true });
      done(true);
      break;
    case "copied-submit":
      ev({ type: "submit-copied", stack: c.stack });
      done(true);
      break;
    case "decline-push":
      if (s.pushes[c.push]?.rev || !s.needsUser.some((n) => n.key === `approve-push:${c.push}`)) {
        done(false, `push ${c.push} isn't waiting for your approval`);
        break;
      }
      ev({ type: "try-declined", push: c.push, text: c.text });
      done(true);
      break;
    case "revise-push": {
      const p = s.pushes[c.push];
      const waiting = s.needsUser.some((n) => n.key === `approve-push:${c.push}`);
      if (!p || p.rev || p.replan || !(waiting || (p.declined !== undefined && !p.withdrawn))) {
        done(false, `push ${c.push} can't be planned again`);
        break;
      }
      ev({ type: "try-declined", push: c.push, text: c.text, replan: true });
      done(true);
      break;
    }
    case "set-bug":
      if (c.patch === "meta") {
        ev({ type: "meta-bug", bug: c.bug, ...(s.metaBug?.draft ? { draft: s.metaBug.draft } : {}) });
        for (const n of s.needsUser.filter((x) => x.key.startsWith("meta-bug:"))) ev({ type: "user-done", key: n.key });
      } else {
        // The bug filed from a draft is that of every patch the draft is for.
        for (const patch of sameBugDraft(s, c.patch)) {
          const { deps: _d, review: _r, replyDrafts: _rd, id, ...p } = patch;
          ev({ type: "patch", patch: id, ...p, bug: c.bug, bugFromYou: true });
          for (const n of s.needsUser.filter((x) => x.key.startsWith("file-bug:") && x.patch === id)) ev({ type: "user-done", key: n.key });
        }
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
          purpose: { key: `revise-draft:${c.patch}:${c.id}`, what: "revise-draft", patch: c.patch, reason: c.text },
          kind: "agent",
          name: "revise-bug-draft",
          // Listed with its group's other jobs.
          ...(c.patch !== "meta" && s.patches[c.patch].item ? { item: s.patches[c.patch].item } : {}),
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
      const errors = [...byItem].map(([item, lines]) => resume(item, "stack comments", `Review comments on your patch, from stack-viewer:\n${lines.join("\n")}\n\nAddress them by amending your commit, then end with the JSON report again. If you think it is wrong, don't do it: leave your commits as they are and say why in \`disagreement\`.`)).filter((e) => e);
      done(errors.length === 0, errors.join("; "));
      break;
    }
    case "comment-fix": {
      const item = s.patches[c.patch]?.item;
      const error = item ? resume(item, "comment", `A comment on your fix:\n${c.text}\n\nAddress it by amending your commit, then end with the JSON report again. If you think it is wrong, don't do it: leave your commits as they are and say why in \`disagreement\`.`) : "this patch has no group, so no author to tell";
      done(!error, error);
      break;
    }
    case "set-test-plan": {
      // On your click only: the factory's one write to Phabricator.
      const p = s.patches[c.patch];
      if (p?.revision === undefined) {
        done(false, "this patch has no revision yet");
        break;
      }
      const file = dataPath(ctx.config, s.id, `test-plan-${c.patch}-${c.id}.txt`);
      effects.push({
        type: "start",
        plan: {
          purpose: { key: `set-test-plan:${c.patch}:${c.id}`, what: "set-test-plan", patch: c.patch, reason: `${p.revision}\n${c.text.trim()}` },
          kind: "script",
          name: "phab.ts set-test-plan",
          ...(p.item ? { item: p.item } : {}),
          cwd: requestDir(ctx.config, s.id),
          files: [{ path: file, content: c.text.trim() + "\n" }],
          cli: { tool: "phab.ts", args: ["set-test-plan", `D${p.revision}`, "--file", file] },
        },
      });
      done(true);
      break;
    }
    case "revise-test-plan": {
      // The agent that wrote it, in its session.
      const last = view.jobs.findLast((j) => j.purpose.what === "test-plan" && j.purpose.patch === c.patch && j.sessionId);
      if (!last) {
        done(false, "no test plan to revise");
        break;
      }
      if (!last.end) {
        done(false, "its test plan is being written: send it again when it's done");
        break;
      }
      effects.push({
        type: "start",
        plan: {
          purpose: { key: `${last.purpose.key.split(":").slice(0, 3).join(":")}:revise:${c.id}`, what: "test-plan", patch: c.patch, reason: c.text },
          kind: "agent",
          name: "write-test-plan",
          ...(last.item ? { item: last.item } : {}),
          cwd: last.cwd,
          agent: { sessionId: last.sessionId!, resume: true, message: `Revise the test plan: ${c.text}\n\nThen end with the JSON report again.` },
        },
      });
      done(true);
      break;
    }
    case "poll-phab":
      ev({ type: "poll-requested" });
      done(true);
      break;
    case "redo-annotations":
      ev({ type: "item-state", item: ANNOTATIONS_ITEM, state: "not started", detail: "redone with today's skip-ifs" });
      for (const n of s.needsUser.filter((x) => x.key.startsWith("approve-push:unskip"))) {
        ev({ type: "try-declined", push: n.key.slice("approve-push:".length), text: "not needed anymore: the skip-ifs group was redone", by: "factory" });
      }
      // What the earlier run asked you is moot.
      for (const n of s.needsUser.filter((x) => x.item === ANNOTATIONS_ITEM || (x.job !== undefined && s.jobs[x.job]?.item === ANNOTATIONS_ITEM))) ev({ type: "user-done", key: n.key });
      done(true);
      break;
    case "take-it":
      ev({ type: "user-done", key: `take-it:${c.item}` });
      done(true);
      break;
    case "hand-back":
      ev({ type: "item-state", item: c.item, state: "handed back" });
      ev({ type: "user-done", key: `take-it:${c.item}` });
      // Leaving a test to whoever is on it leaves all its groups.
      if (s.needsUser.some((n) => n.key === `take-it:${c.item}`)) {
        const test = s.items[c.item]?.group.tests[0];
        for (const i of Object.values(s.items)) if (i.id !== c.item && i.group.tests[0] === test && !TERMINAL.includes(i.state)) ev({ type: "item-state", item: i.id, state: "handed back" });
      }
      // A stuck group handed back asks nothing more.
      for (const n of s.needsUser.filter((x) => x.item === c.item || (x.job !== undefined && s.jobs[x.job]?.item === c.item))) ev({ type: "user-done", key: n.key });
      done(true);
      break;
    case "reply-recovery": {
      const job = view.jobs.find((j) => j.job === c.job);
      if (!job?.sessionId) {
        done(false, "that recovery plan has no session to reply to");
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
    case "retry":
    case "retry-job": {
      const job = view.jobs.find((j) => j.job === c.job);
      const saved = ctx.plan(c.job);
      if (!job || !saved) {
        done(false, "that job is unknown");
        break;
      }
      // Like next(), never again on its own: the push may have happened, unless it refused to. A recovery plan can
      // still ask for it.
      if (c.cmd === "retry" && !canRetry(s!, s!.jobs[job.job])) {
        done(false, "a try push isn't retried from its ⚑ (it may have been made): ask the factory to plan it again");
        break;
      }
      if (job.sessionId && view.jobs.some((j) => j.sessionId === job.sessionId && !j.end)) {
        done(false, `${job.name}${job.item ? ` of ${itemName(job.item)}` : ""} is still running: retry it once it's done`);
        break;
      }
      // The same plan through the same path, so a dry run still adds --dry-run (or refuses).
      const plan: JobPlan =
        job.kind === "agent" && job.sessionId
          ? { purpose: { ...job.purpose, retried: true }, kind: "agent", name: job.name, item: job.item, cwd: job.cwd, agent: { sessionId: job.sessionId, resume: true, message: "Try again: continue where you stopped, then end with the JSON report." } }
          : { ...saved, purpose: { ...job.purpose } };
      // A resumed agent isn't started again: its group's line says so.
      plan.startEvents = plan.agent?.resume ? saved.startEvents?.map((e) => (e.type === "item-state" && e.state === "investigating" ? { ...e, detail: "retried" } : e)) : saved.startEvents;
      effects.push({ type: "start", plan });
      for (const key of [`failed:${c.job}`, `stopped:${c.job}`]) if (s.needsUser.some((n) => n.key === key)) ev({ type: "user-done", key });
      // Out of the blocked state a stop or a failure left it in, unless the job's own start events set one.
      const item = job.item === undefined ? undefined : s.items[job.item];
      if (item?.state === "blocked" && !saved.startEvents?.some((e) => e.type === "item-state")) ev({ type: "item-state", item: item.id, state: "investigating", detail: "retried" });
      if (job.item !== undefined) reopen(job.item);
      done(true, c.cmd === "retry-job" ? c.reason : undefined);
      break;
    }
    case "stop": {
      const job = s.jobs[c.job];
      if (!job || job.endedAt !== undefined) {
        done(false, "that job isn't running anymore");
        break;
      }
      if (isPushJob(job)) {
        done(false, "a try push isn't stopped (it may already have been made)");
        break;
      }
      effects.push({ type: "cancel", job: c.job, request: s.id, detail: CANCELLED });
      // Cancelled jobs aren't retried: what needed this one waits for your Retry or Continue.
      const item = job.item === undefined ? undefined : s.items[job.item];
      if (item) ev({ type: "item-state", item: item.id, state: "blocked", detail: STOPPED });
      ev({ type: "needs-user", key: `stopped:${c.job}`, action: `${job.name} ${STOPPED}`, detail: item ? "Retry it, or tell its author what to do instead." : "Retry it, or dismiss this.", job: c.job, ...(item ? { item: item.id } : {}) });
      done(true);
      break;
    }
    case "accept-review":
      if (!reviewLimitFlag(s, c.item)) {
        done(false, `${itemName(c.item)} isn't waiting for you after its critical review rounds`);
        break;
      }
      ev({ type: "item-state", item: c.item, state: "reviewed", detail: "accepted by you" });
      clearItemFlags(c.item);
      done(true);
      break;
    case "allow-push": {
      const session = view.jobs.filter((j) => j.item === c.item && j.purpose.what === "author" && j.sessionId).at(-1)?.sessionId;
      if (!session) {
        done(false, `${itemName(c.item)} has no author session`);
        break;
      }
      effects.push({ type: "allow-push", sessionId: session });
      ev({ type: "note", text: `You allowed ${itemName(c.item)}'s author one try push.` });
      done(true);
      break;
    }
    case "continue": {
      const error = resume(c.item, "continue", `A message from the user:\n${c.text}\n\nDo what it says, amending your commit if your fix changes, then end with the JSON report again. If you think it is wrong, don't do it: leave your commits as they are and say why in \`disagreement\`.`);
      if (!error) {
        clearItemFlags(c.item);
        reopen(c.item);
      }
      done(!error, error);
      break;
    }
    case "dismiss":
      if (!canDismiss(c.key)) {
        done(false, `${c.key} is answered by its own buttons`);
        break;
      }
      ev({ type: "user-done", key: c.key });
      done(true);
      break;
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
      if (!item || !session || c.item === ANNOTATIONS_ITEM) {
        done(false, `the investigation of ${itemName(c.item)} can only be restarted after a first one`);
        break;
      }
      // A fresh session in the same worktree, with the first run's inputs plus what you said.
      const key = `author:${c.item}${itemEpochOf(view, c.item)}:start:${c.id}`;
      effects.push({
        type: "start",
        plan: {
          purpose: { key, what: "author", item: c.item, reason: "start" },
          kind: "agent",
          name: session.name,
          item: c.item,
          cwd: session.cwd,
          agent: { sessionId: sessionIdFor(s.id, key), resume: false, vars: { ...startVars(item.group.tests, session.cwd), failureSummary: `"${item.group.message}" on ${item.group.configs.length} configs.\n\nInstructions for this run: ${c.prompt}` } },
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
    case "hand-off": {
      // The factory stops working on them first: their running jobs stop, and their state keeps next() away.
      for (const item of c.items) {
        for (const j of Object.values(s.jobs).filter((x) => x.item === item && x.endedAt === undefined && !isPushJob(x))) effects.push({ type: "cancel", job: j.job, request: s.id, detail: CANCELLED });
        ev({ type: "item-state", item, state: "taken over", detail: c.reason.slice(0, 300) });
        for (const n of s.needsUser.filter((x) => x.item === item || (x.job !== undefined && s.jobs[x.job]?.item === item))) ev({ type: "user-done", key: n.key });
      }
      const referencesFile = dataPath(ctx.config, s.id, `hand-off-${c.id}.json`);
      effects.push({
        type: "start",
        plan: {
          purpose: { key: `hand-off:${c.id}`, what: "hand-off", reason: c.items.join(" ") },
          kind: "agent",
          name: "write-hand-off",
          cwd: requestDir(ctx.config, s.id),
          files: [{ path: referencesFile, content: JSON.stringify(handOffReferences(ctx.config, s, c.items), null, 2) + "\n" }],
          agent: { sessionId: sessionIdFor(s.id, `hand-off:${c.id}`), resume: false, vars: { id: s.id, firefoxRepo: ctx.config.firefoxRepo, referencesFile, why: c.reason } },
        },
      });
      done(true, c.reason);
      break;
    }
    case "split-request": {
      const problem = splitProblem(s, c.parts);
      if (problem) {
        done(false, problem);
        break;
      }
      const events = ctx.events!(s.id);
      const taken = new Set<RequestId>();
      const ids = c.parts.map((p) => {
        const id = newRequestId({ t: c.t, text: p.title }, (x) => taken.has(x) || ctx.exists(x));
        taken.add(id);
        return id;
      });
      c.parts.forEach((p, n) => {
        const to = ids[n];
        const at = (e: RequestEvent): Effect => ({ type: "event", event: { ...e, request: to } as EventInput });
        effects.push(
          at({ type: "request-created", kind: s.kind, text: p.title, ...(s.folder !== undefined ? { folder: s.folder } : {}), ...(s.rev !== undefined ? { rev: s.rev } : {}), command: c.id }),
          at({ type: "split-from", from: s.id }),
          at({ type: "config-set", config: s.config }),
          ...partEvents(events, s, p.items, to).flatMap((event): Effect[] => [
            { type: "event", event },
            ...(event.type === "job-started" && event.kind === "agent" ? [{ type: "copy-report", job: event.job, from: s.id, to } as const] : []),
          ]),
          at({ type: "note", text: `Split from ${s.id}: ${c.reason}` }),
          // Its groups are where they were: settled ones go on to their own stack.
          at({ type: "step", step: p.items.every((i) => SETTLED.includes(s.items[i].state)) ? "stack" : "investigate and fix" }),
        );
      });
      ev({ type: "request-split", into: ids });
      ev({ type: "note", text: `Split into ${ids.join(", ")}: ${c.reason}` });
      for (const n of s.needsUser) ev({ type: "user-done", key: n.key, byFactory: true });
      ev({ type: "step", step: "done" });
      done(true, c.reason);
      break;
    }
    case "shell":
      effects.push({ type: "start", plan: { purpose: { key: `shell:${c.id}`, what: "shell" }, kind: "script", name: "shell", cwd: c.cwd, cmd: ["sh", "-c", c.command] } });
      done(true, c.reason);
      break;
  }
  return effects;
}

const PLANNED = new Set<string>(["retry-job", "cancel-job", "resume-agent", "start-agent", "set-state", "redo-step", "edit-config", "shell", "hand-off", "split-request"] satisfies PlannedCommand["cmd"][]);

export const STOPPED = "stopped by you";

function startVars(tests: string[], worktree: string): Record<string, string> {
  return { test: tests.length > 1 ? `${tests[0]} (and ${tests.length - 1} other tests)` : tests[0], worktree };
}
