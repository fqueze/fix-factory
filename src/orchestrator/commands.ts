// What each command does, as effects the loop carries out. Pure. Jobs a command starts skip the
// caps: you asked for them. Recovery commands come from an approved plan and run exactly as written.
import type { InboxMessage } from "../agents/inbox.ts";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { itemDir } from "../lib/kept.ts";
import type { EventInput } from "../state/events.ts";
import { sameBugDraft } from "../state/meta-bug.ts";
import { canDismiss, canRetry, isPushJob, reviewLimitFlag } from "../state/flags.ts";
import type { Command, Event, FactoryConfig, ItemId, JobId, PatchId, PlannedCommand, RequestId, RequestState, ReviewComment } from "../types.ts";
import { REQUEST_STEPS } from "../server/commands.ts";
import { ANNOTATIONS_ITEM, authorJobsOf, CANCELLED, DEBUG_PLAN, firstPlan, pendingDebugPush, freshAuthorPlan, NEVER_STARTED, itemEpochOf, lostSession, SETTLED, TERMINAL, resumeAuthorPlan, removedWorktree } from "./next.ts";
import { handOffReferences } from "./hand-off.ts";
import { moveProblem, movingProblem, partEvents, splitProblem } from "./split.ts";
import { dataPath, requestDir, sessionIdFor, slug, type JobPlan } from "./plan.ts";
import type { View } from "./view.ts";
import type { Fingerprint } from "../state/approval.ts";
import { patchFindings } from "../state/findings.ts";

// An event of this command's request, without repeating the request.
type RequestEvent = EventInput extends infer E ? (E extends unknown ? Omit<E, "request"> : never) : never;

export type Effect =
  | { type: "event"; event: EventInput }
  | { type: "start"; plan: JobPlan }
  | { type: "cancel"; job: JobId; request: RequestId; detail: string } // then job-finished with error CANCELLED
  | { type: "start-now"; request: RequestId }
  | { type: "allow-push"; sessionId: string } // no-push.ts lets that session make one push
  | { type: "copy-report"; job: JobId; from: RequestId; to: RequestId } // a split's: its agent's report, if it has one
  | { type: "inbox"; session: string; message: InboxMessage }; // a message for a running agent (inbox.ts)

export interface CommandContext {
  config: FactoryConfig;
  state?: RequestState; // the command's request
  other?: (request: RequestId) => RequestState | undefined; // another request's state, for move-groups
  view?: View;
  exists: (request: RequestId) => boolean;
  plan: (job: JobId) => JobPlan | undefined; // jobs/<job>/plan.json, what the runner started
  unroutable?: RequestState[]; // for a global tell-factory: open requests whose route-request failed twice
  events?: (request: RequestId) => Event[]; // a request's events, for split-request
  fingerprint: Fingerprint; // of a commit, for approve (src/lib/fingerprint.ts)
  report: (job: JobId) => unknown; // an agent's validated report, for the findings review-send answers
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
    return tests.length === 1 ? tests[0].split("/").pop()! : tests.length > 1 ? `the item of ${tests.length} tests` : "this item";
  };
  // The key of the author run that answers it: the one resumed, or the one running, which gets it in its inbox.
  let answeredBy = "";
  const resume = (item: ItemId, reason: string, message: string): string | undefined => {
    const plan = resumeAuthorPlan(s!.id, view!, item, reason, { message }, "investigating");
    if (plan === undefined) return `${itemName(item)} has no author session to resume`;
    if (plan === "busy") {
      const running = authorJobsOf(view!, item).at(-1);
      if (!running?.sessionId || running.end !== undefined) return `the author of ${itemName(item)} is running: send it again when it's done`;
      ev({ type: "agent-message", item, job: running.job, session: running.sessionId, msg: c.id, text: message });
      effects.push({ type: "inbox", session: running.sessionId, message: { id: c.id, text: message, t: c.t } });
      answeredBy = running.purpose.key;
      return undefined;
    }
    plan.purpose.key = `author:${item}${itemEpochOf(view!, item)}:${reason.replace(/\s+/g, "-")}:${c.id}`;
    answeredBy = plan.purpose.key;
    // Its worktree was removed: the planner restores it, then resumes the author with this.
    if (removedWorktree(view!, plan.cwd)) {
      ev({ type: "author-queued", item, key: plan.purpose.key, reason, message });
      return undefined;
    }
    effects.push({ type: "start", plan });
    return undefined;
  };
  // The agent that wrote a patch's test plan, in its session: the key of its run, or why there's none now.
  const reviseTestPlan = (patch: PatchId, suffix: string, message: string): { key: string } | { error: string } => {
    const last = view!.jobs.findLast((j) => j.purpose.what === "test-plan" && j.purpose.patch === patch && j.sessionId);
    if (!last) return { error: "no test plan to revise" };
    if (!last.end) return { error: "its test plan is being written: send it again when it's done" };
    const key = `${last.purpose.key.split(":").slice(0, 3).join(":")}:${suffix}`;
    effects.push({
      type: "start",
      plan: {
        purpose: { key, what: "test-plan", patch, reason: message },
        kind: "agent",
        name: "write-test-plan",
        ...(last.item ? { item: last.item } : {}),
        cwd: last.cwd,
        agent: { sessionId: last.sessionId!, resume: true, message: `${message}\n\nThen end with the JSON report again.` },
      },
    });
    return { key };
  };
  // Your message to an item's author: its running session is told now, after its current tool call (inbox.ts); else
  // the session is resumed with it.
  const tell = (item: ItemId, text: string): [boolean, string | undefined] => {
    const running = authorJobsOf(view!, item).at(-1);
    if (running && running.end === undefined && running.sessionId) {
      ev({ type: "agent-message", item, job: running.job, session: running.sessionId, msg: c.id, text });
      effects.push({ type: "inbox", session: running.sessionId, message: { id: c.id, text, t: c.t } });
      return [true, undefined];
    }
    const error = resume(item, "continue", `A message from the user:\n${text}\n\nDo what it says, amending your commit if your fix changes, then end with the JSON report again. If you think it is wrong, don't do it: leave your commits as they are and say why in \`disagreement\`.${draftsNote(s!, item)}`);
    if (!error) {
      clearItemFlags(item);
      // Its author's cancelled runs aren't reopened: this run is their answer, and two would resume one session.
      reopen(item, (j) => j.purpose.what !== "author");
    }
    return [!error, error];
  };
  // The ⚑s that wait on an item's way forward.
  const clearItemFlags = (item: ItemId) => {
    for (const n of s!.needsUser.filter((x) => x.item === item && ["failed:", "stopped:", "disagrees:", "question:"].some((k) => x.key.startsWith(k)))) ev({ type: "user-done", key: n.key });
  };
  // Keys of the item whose job you stopped: next() may start them again (a stopped lint would otherwise stay
  // stopped when the author comes back with the same commit).
  const reopen = (item: ItemId, which: (j: { purpose: { what: string } }) => boolean = () => true) => {
    for (const j of view!.jobs.filter((x) => x.item === item && x.end?.error?.startsWith(CANCELLED) && !view!.done.has(`reopen:${x.job}`) && which(x))) ev({ type: "user-done", key: `reopen:${j.job}` });
  };

  switch (c.cmd) {
    case "presence":
      return effects; // the loop tracks presence from the commands themselves
    case "tell-factory":
      if (c.request === undefined && c.routed) {
        // Routed: the request, under an id made from its title; the text's own request forwards to it.
        const { from, title, kind, folder, rev, config } = c.routed;
        const request = newRequestId({ t: c.t, text: title }, ctx.exists);
        effects.push({ type: "event", event: { type: "request-created", request, kind, text: c.text, title, ...(folder !== undefined ? { folder } : {}), ...(rev !== undefined ? { rev } : {}), command: c.id } });
        effects.push({ type: "event", event: { type: "config-set", request, config } as EventInput });
        effects.push({ type: "event", event: { type: "request-forwarded", request: from, to: request, asNew: true } });
        effects.push({ type: "event", event: { type: "step", request: from, step: "done" } });
        return effects;
      }
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
  // Its groups went on in the requests it was split into: what's sent here (an approved plan's other commands
  // included, run after the split) would act on copies nobody follows.
  if (s.splitInto && c.cmd !== "dismiss") {
    done(false, `this request was split into ${s.splitInto.join(", ")}: send it there`);
    return effects;
  }

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
      // The meta bug's agent, which knows the stack and works in its worktree, rather than one that sees the text.
      const meta = c.patch === "meta" ? view.jobs.findLast((j) => j.purpose.what === "meta-draft" && j.sessionId && j.end) : undefined;
      if (meta) {
        effects.push({
          type: "start",
          plan: {
            purpose: { key: `meta-draft:${meta.purpose.stack}:revise:${c.id}`, what: "meta-draft", stack: meta.purpose.stack, draft: { ...draft, description: "" }, reason: c.text },
            kind: "agent",
            name: "write-meta-bug",
            cwd: meta.cwd,
            agent: {
              sessionId: meta.sessionId!,
              resume: true,
              message: `The user comments on the meta bug draft:\n${c.text}\n\nDo what they ask. Look up what you need yourself: \`git log\` and \`git blame\` here, searchfox-cli, Bugzilla's REST API with curl (https://bugzilla.mozilla.org/rest/bug?...). Never ask them for something you can find. Bug fields they ask for go in the report's \`product\`, \`component\` and \`blocks\` (the bugs to add). Then end with the JSON report again, saying in \`answer\` what you changed, and for what you didn't, why and what you checked.`,
            },
          },
        });
        done(true);
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
      const sent = new Map<ItemId, string>();
      const errors = [...byItem]
        .map(([item, lines]) => {
          const error = resume(item, "stack comments", `Review comments on your patch, from stack-viewer:\n${lines.join("\n")}\n\nAddress them by amending your commit, then end with the JSON report again. ${ANSWER_EACH} If you think one is wrong, don't do it and say why in \`disagreement\`.${draftsNote(s, item)}`);
          if (!error) sent.set(item, answeredBy);
          return error;
        })
        .filter((e) => e);
      // Each comment and the run that answers it, shown on its patch.
      for (const x of c.comments) {
        const item = s.patches[x.patch]?.item;
        if (item && sent.has(item)) ev({ type: "comment-sent", patch: x.patch, text: x.text, key: sent.get(item)! });
      }
      done(errors.length === 0, errors.join("; "));
      break;
    }
    case "comment-fix": {
      const item = s.patches[c.patch]?.item;
      const error = item ? resume(item, "comment", `A comment on your fix:\n${c.text}\n\nAddress it by amending your commit, then end with the JSON report again. ${ANSWER_EACH} If you think it is wrong, don't do it: leave your commits as they are and say why in \`disagreement\`.${draftsNote(s, item)}`) : "this patch has no group, so no author to tell";
      if (!error) ev({ type: "comment-sent", patch: c.patch, text: c.text, key: answeredBy });
      done(!error, error);
      break;
    }
    case "approve": {
      const fingerprint = ctx.fingerprint(c.sha);
      if (fingerprint === undefined) {
        done(false, `git can't read commit ${c.sha.slice(0, 12)}`);
        break;
      }
      ev({ type: "patch-approved", patch: c.patch, sha: c.sha, fingerprint });
      done(true);
      break;
    }
    case "review-send": {
      // Your new comments and your answers to earlier ones, a resumed author per item; what needs no author (done,
      // ignore, reopen, a reply to post on Phabricator) is only recorded.
      const toAuthor = new Map<ItemId, { lines: string[]; comments: typeof c.comments; responses: typeof c.responses }>();
      const errors: string[] = [];
      const forAuthor = (patch: string, line: string, x: { comment?: (typeof c.comments)[number]; response?: (typeof c.responses)[number] }) => {
        const item = s.patches[patch].item;
        if (!item) {
          errors.push(`${s.patches[patch].title} has no work item, so no author to tell`);
          return;
        }
        const e = toAuthor.get(item) ?? { lines: [], comments: [], responses: [] };
        e.lines.push(`- On ${s.patches[patch].title}: ${line}`);
        if (x.comment) e.comments.push(x.comment);
        if (x.response) e.responses.push(x.response);
        toAuthor.set(item, e);
      };
      // Comments on a test plan go to the agent that wrote it, one message per patch; the others to the author.
      const onPlans = new Map<PatchId, typeof c.comments>();
      for (const x of c.comments) {
        if (x.anchor?.file === "(section:test-plan)") onPlans.set(x.patch, [...(onPlans.get(x.patch) ?? []), x]);
        else forAuthor(x.patch, commentLine(x), { comment: x });
      }
      for (const [patch, xs] of onPlans) {
        const r = reviseTestPlan(patch, `review:${c.id}`, `The user's review comments on the test plan you wrote:\n${xs.map((x) => `- ${commentLine(x)}`).join("\n")}\n\nWrite it again for them, keeping what you were asked before.`);
        if ("error" in r) {
          errors.push(`${s.patches[patch].title}: ${r.error}`);
          continue;
        }
        for (const x of xs) {
          const lines = sectionLines(s.patches[patch].testPlan, x.anchor!.line);
          ev({ type: "comment-sent", patch, text: x.text, ...(x.quote ? { quote: x.quote } : {}), key: r.key, ...(x.id ? { id: x.id } : {}), anchor: x.anchor!, sha: x.sha ?? s.patches[patch].sha, ...(lines ? { lines } : {}) });
        }
      }
      for (const x of c.responses) {
        const p = s.patches[x.patch];
        const record = () => ev({ type: "comment-response", patch: x.patch, comment: x.id, response: x.response, ...(x.text !== undefined ? { text: x.text } : {}) });
        // A reply written goes with whichever response was chosen last: a reply, then done ticked, keeps the reply.
        const phab = /^phab-(\d+)$/.exec(x.id);
        const comment = phab ? p.review?.comments.find((k) => k.id === Number(phab[1])) : undefined;
        if (comment) {
          // As the factory's own drafts: shown on the request page for you to post.
          if (x.text !== undefined) ev({ type: "reply-draft", patch: x.patch, commentId: comment.id, text: x.text });
          if (x.response === "address") {
            forAuthor(x.patch, `address this comment of ${comment.author} on Phabricator (D${p.review!.revision}${comment.file ? `, ${comment.file}${comment.line ? `:${comment.line}` : ""}` : ""}): ${comment.text}${comment.suggestion ? `\n  Suggested edit:\n${quoted(comment.suggestion.split("\n"))}` : ""}${x.text ? `\n  The user's reply to it, to post: ${x.text}` : ""}`, { response: x });
          } else record();
          continue;
        }
        const finding = x.id.startsWith("f-") ? patchFindings(s, p, ctx.report).find((f) => f.id === x.id) : undefined;
        if (finding) {
          if (x.response === "address") forAuthor(x.patch, `address this finding of a critical review (${finding.severity}${finding.file ? `, ${finding.file}${finding.line ? `:${finding.line}` : ""}` : ""}): ${finding.text}${x.text ? `\n  The user adds: ${x.text}` : ""}`, { response: x });
          else record();
          continue;
        }
        // Yours, by its id; one from before ids is an entry of its text (<id>-<n>).
        const yours = p.yourComments?.find((k) => k.id === x.id || x.id.startsWith(`${k.id}-`));
        if (yours && (x.text !== undefined || x.response === "address" || x.response === "reply")) {
          forAuthor(x.patch, `about the user's earlier comment:\n${quoted(yours.text.split("\n"))}\nthey now say: ${x.text ?? "address it"}`, { response: x });
          continue;
        }
        if (yours || x.response === "done" || x.response === "ignore" || x.response === "reopen") {
          record();
          continue;
        }
        errors.push(`no comment ${x.id} on ${p.title}`);
      }
      for (const [item, e] of toAuthor) {
        const error = resume(item, "stack comments", `Review comments on your patch, from stack-viewer:\n${e.lines.join("\n")}\n\nAddress them by amending your commit, then end with the JSON report again. ${ANSWER_EACH} If you think one is wrong, don't do it and say why in \`disagreement\`.${draftsNote(s, item)}`);
        if (error) {
          errors.push(error);
          continue;
        }
        const key = `author:${item}${itemEpochOf(view, item)}:stack-comments:${c.id}`;
        for (const x of e.comments) ev({ type: "comment-sent", patch: x.patch, text: x.text, ...(x.quote ? { quote: x.quote } : {}), key, ...(x.id ? { id: x.id } : {}), ...(x.anchor ? { anchor: x.anchor } : {}), sha: x.sha ?? s.patches[x.patch].sha });
        for (const x of e.responses) ev({ type: "comment-response", patch: x.patch, comment: x.id, response: x.response, ...(x.text !== undefined ? { text: x.text } : {}), key });
      }
      done(errors.length === 0, errors.join("; "));
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
      const r = reviseTestPlan(c.patch, `revise:${c.id}`, `Revise the test plan: ${c.text}`);
      done(!("error" in r), "error" in r ? r.error : undefined);
      break;
    }
    case "set-reviewer": {
      const st = Object.values(s.stacks).find((x) => x.order.includes(c.patch));
      ev({ type: "reviewer-set", patch: c.patch, reviewer: c.reviewer.trim() });
      if (st) for (const n of s.needsUser.filter((x) => x.key === `reviewers:${st.id}:${c.patch}`)) ev({ type: "user-done", key: n.key });
      done(true);
      break;
    }
    case "follow-up": {
      const item = s.patches[c.patch]?.item;
      if (!item || !s.pushes[c.push]) {
        done(false, "no such push or patch");
        break;
      }
      ev({ type: "follow-up", push: c.push, item });
      done(true);
      break;
    }
    case "verify-stack":
      ev({ type: "verify-asked", text: c.reason });
      done(true, c.reason);
      break;
    case "push-debug": {
      // One push of DEBUG commits of their own at a time: the next one waits for its results.
      const pending = pendingDebugPush(s!, view!);
      const asked = s!.debugPushAsked;
      if (s!.items[c.item]?.state !== "waiting for a try repro") done(false, `${itemName(c.item)} isn't waiting for a try repro`);
      else if (pending) done(false, `A try push of DEBUG commits is already on its way (${pending.startsWith("debug-") ? `push ${pending}` : "being prepared"}): the next one waits for its results`);
      else if (asked && s!.items[asked.item]?.state === "waiting for a try repro" && !view!.jobs.some((j) => DEBUG_PLAN.test(j.purpose.key) && j.startedAt >= Date.parse(asked.t))) done(false, "Already asked: the factory is preparing that push");
      else {
        ev({ type: "debug-push-asked", item: c.item });
        done(true);
      }
      break;
    }
    case "fix-tests":
      ev({ type: "tests-asked", tests: c.tests, reason: c.reason });
      done(true, c.reason);
      break;
    case "draft-meta-bug":
      ev({ type: "meta-draft-asked" });
      done(true);
      break;
    case "poll-phab":
      ev({ type: "poll-requested" });
      done(true);
      break;
    case "redo-annotations":
      ev({ type: "item-state", item: ANNOTATIONS_ITEM, state: "not started", detail: "redone with today's skip-ifs" });
      for (const n of s.needsUser.filter((x) => x.key.startsWith("approve-push:unskip"))) {
        ev({ type: "try-declined", push: n.key.slice("approve-push:".length), text: "not needed anymore: the skip-if annotations item was redone", by: "factory" });
      }
      // What the earlier run asked you is moot.
      for (const n of s.needsUser.filter((x) => x.item === ANNOTATIONS_ITEM || (x.job !== undefined && s.jobs[x.job]?.item === ANNOTATIONS_ITEM))) ev({ type: "user-done", key: n.key });
      done(true);
      break;
    case "take-it":
      ev({ type: "user-done", key: `take-it:${c.item}`, ...(c.text?.trim() ? { text: c.text.trim() } : {}) });
      done(true);
      break;
    case "take-patch": {
      // Its author's latest run stopped with a fix of a failure it couldn't reproduce: you take the fix as it is.
      const author = authorJobsOf(view, c.item).at(-1);
      const last = s.items[c.item]?.lastReport;
      const commits = last?.job === author?.job ? (last?.report as { commits?: string[] } | undefined)?.commits : undefined;
      if (!author?.end || !commits?.length) {
        done(false, `${itemName(c.item)}'s author has no fix to take`);
        break;
      }
      ev({ type: "user-done", key: `take-patch:${c.item}` });
      for (const n of s.needsUser.filter((x) => x.key === `failed:${author.job}`)) ev({ type: "user-done", key: n.key });
      ev({ type: "item-state", item: c.item, state: "fix verified locally", detail: "You took its fix without a reproduction of the failure" });
      done(true);
      break;
    }
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
      // Its first run's plan, from its prompt: a retry's own plan resumes.
      const fresh = (view.byKey.get(job.purpose.key) ?? []).map((j) => ctx.plan(j.job)).find((p) => p?.agent && !p.agent.resume);
      // An author continues in its session, which holds its work. Another agent starts afresh: its session, where its
      // report failed, may hold that it can't (a tool it decided was broken).
      // Its agent never started (its session never saw the prompt): its first run's plan again, prompt and files.
      const first = job.end?.error?.includes(NEVER_STARTED) ? firstPlan(view, job.purpose.key, ctx.plan) : undefined;
      const plan: JobPlan = first
        ? { ...first, purpose: { ...job.purpose, retried: true } }
        : job.kind === "agent" && job.sessionId && (job.purpose.what === "author" || job.name === "investigate-and-fix") && !lostSession(view, job.sessionId)
          ? { purpose: { ...job.purpose, retried: true }, kind: "agent", name: job.name, item: job.item, cwd: job.cwd, agent: { sessionId: job.sessionId, resume: true, message: "Try again: continue where you stopped, then end with the JSON report." } }
          : fresh?.agent
            ? { ...fresh, purpose: { ...job.purpose, retried: true }, agent: { ...fresh.agent, sessionId: sessionIdFor(s.id, `${job.purpose.key}:retry:${c.id}`) } }
            : { ...saved, purpose: { ...job.purpose } };
      // A resumed agent isn't started again: its group's line says so.
      plan.startEvents = plan.agent?.resume ? saved.startEvents?.map((e) => (e.type === "item-state" && e.state === "investigating" ? { ...e, detail: "retried" } : e)) : saved.startEvents;
      // An author whose worktree the pool freed (its item was idle): the planner brings the worktree back, then
      // resumes it with this.
      if (plan.agent?.resume && job.item !== undefined && removedWorktree(view, plan.cwd)) {
        const key = `author:${job.item}${itemEpochOf(view, job.item)}:retry:${c.id}`;
        // As it is: a run that died before its session saw its prompt (answering review comments) needs that prompt.
        ev({ type: "author-queued", item: job.item, key, reason: "continue", message: plan.agent.message ?? "Try again: continue where you stopped, then end with the JSON report.", plan: { ...plan, purpose: { ...plan.purpose, key } } });
        for (const k of [`failed:${c.job}`, `stopped:${c.job}`]) if (s.needsUser.some((n) => n.key === k)) ev({ type: "user-done", key: k });
        done(true);
        break;
      }
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
    case "continue":
      done(...tell(c.item, c.text));
      break;
    // Its author is told the number, to reference it where it said it would.
    case "follow-up-bug": {
      const n = s.needsUser.find((x) => x.key === c.key && x.item === c.item);
      if (!n?.bugDraft) {
        done(false, `${c.key} is no follow-up bug to file`);
        break;
      }
      const [ok, error] = tell(c.item, `You suggested the follow-up bug “${n.bugDraft.summary}”: it is filed as bug ${c.bug}. Reference it where you said you would (a comment in the code, your reply to the reviewer), and change nothing else.`);
      if (ok) ev({ type: "user-done", key: c.key });
      done(ok, error);
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
      // Its ⚑s are answered by what you approved, as by a message of yours.
      if (!error) clearItemFlags(c.item);
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
      const key = `author:${c.item}${itemEpochOf(view, c.item)}:start:${c.id}`;
      // A fresh start answers the ⚑s its failed or stopped runs raised.
      clearItemFlags(c.item);
      // Its worktree went to another item meanwhile: it comes back first, then the session starts (next.ts).
      if (removedWorktree(view, session.cwd)) {
        ev({ type: "author-queued", item: c.item, key, reason: "start", message: c.prompt });
        done(true, `${c.reason ? `${c.reason}; ` : ""}its worktree comes back first`);
        break;
      }
      effects.push({ type: "start", plan: freshAuthorPlan(s, view, ctx.config.stateDir, c.item, key, c.prompt)! });
      done(true, c.reason);
      break;
    }
    case "set-state": {
      // "fixed" is an item with patches of its own in the stack: one with none (another item's fix covers it) is closed.
      const own = Object.values(s.patches).some((p) => p.item === c.item);
      ev({ type: "item-state", item: c.item, state: c.state === "fixed" && !own ? "left as-is" : c.state, detail: c.reason.slice(0, 300) });
      clearItemFlags(c.item);
      done(true);
      break;
    }
    case "redo-step":
      // A stack on Phabricator doesn't go back: a try push of it is verify-stack, more fixes fix-tests.
      if (!c.item && REQUEST_STEPS.indexOf(c.step) < REQUEST_STEPS.indexOf("review comments") && Object.values(s.patches).some((p) => p.revision !== undefined)) {
        done(false, `the stack is on Phabricator: it doesn't go back to ${c.step}. For a try push of it, ask for one (verify-stack); for more fixes, fix-tests`);
        break;
      }
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
          ...partEvents(events, s, p.groups.map((g) => g.item), to).flatMap((event): Effect[] => [
            { type: "event", event },
            ...(event.type === "job-started" && event.kind === "agent" ? [{ type: "copy-report", job: event.job, from: s.id, to } as const] : []),
          ]),
          at({ type: "note", text: `Split from ${s.id}: ${c.reason}` }),
          // Its groups are where they were: settled ones go on to their own stack.
          at({ type: "step", step: p.groups.every((g) => SETTLED.includes(s.items[g.item].state)) ? "stack" : "investigate and fix" }),
        );
      });
      ev({ type: "request-split", into: ids, moved: Object.fromEntries(c.parts.flatMap((p, n) => p.groups.map((g) => [g.item, ids[n]]))) });
      ev({ type: "note", text: `Split into ${ids.join(", ")}: ${c.reason}` });
      for (const n of s.needsUser) ev({ type: "user-done", key: n.key, byFactory: true });
      ev({ type: "step", step: "done" });
      done(true, c.reason);
      break;
    }
    case "move-groups": {
      const items = c.groups.map((g) => g.item);
      const problem = moveProblem(s, ctx.other!(c.to), items);
      if (problem) {
        done(false, problem);
        break;
      }
      const at = (e: RequestEvent): Effect => ({ type: "event", event: { ...e, request: c.to } as EventInput });
      effects.push(
        ...partEvents(ctx.events!(s.id), s, items, c.to, { pushes: false }).flatMap((event): Effect[] => [
          { type: "event", event },
          ...(event.type === "job-started" && event.kind === "agent" ? [{ type: "copy-report", job: event.job, from: s.id, to: c.to } as const] : []),
        ]),
        at({ type: "note", text: `Moved from ${s.id}: ${c.groups.map((g) => `${g.item} (${g.why})`).join("; ")}` }),
      );
      // Taken over: out of this stack, and its worktree, now the other request's, kept.
      for (const item of items) {
        ev({ type: "item-state", item, state: "taken over", detail: `moved to ${c.to}` });
        for (const n of s.needsUser.filter((x) => x.item === item || (x.job !== undefined && s.jobs[x.job]?.item === item))) ev({ type: "user-done", key: n.key, byFactory: true });
      }
      ev({ type: "groups-moved", to: c.to, items });
      done(true, c.reason);
      break;
    }
    case "split-off": {
      // Like a split's part, but this request goes on with the rest: its landed and submitted patches stay its own.
      const items = c.groups.map((g) => g.item);
      const problem = movingProblem(s, items);
      if (problem) {
        done(false, problem);
        break;
      }
      const to = newRequestId({ t: c.t, text: c.title }, ctx.exists);
      const at = (e: RequestEvent): Effect => ({ type: "event", event: { ...e, request: to } as EventInput });
      effects.push(
        at({ type: "request-created", kind: s.kind, text: c.title, ...(s.folder !== undefined ? { folder: s.folder } : {}), ...(s.rev !== undefined ? { rev: s.rev } : {}), command: c.id }),
        at({ type: "split-from", from: s.id }),
        at({ type: "config-set", config: s.config }),
        // Not this request's try pushes: they tested its stack, which goes on here.
        ...partEvents(ctx.events!(s.id), s, items, to, { pushes: false }).flatMap((event): Effect[] => [
          { type: "event", event },
          ...(event.type === "job-started" && event.kind === "agent" ? [{ type: "copy-report", job: event.job, from: s.id, to } as const] : []),
        ]),
        at({ type: "note", text: `Split off ${s.id}: ${c.reason}` }),
        at({ type: "step", step: items.every((i) => SETTLED.includes(s.items[i].state)) ? "stack" : "investigate and fix" }),
      );
      // Out of this stack, their worktrees the new request's.
      for (const item of items) {
        ev({ type: "item-state", item, state: "taken over", detail: `moved to ${to}` });
        for (const n of s.needsUser.filter((x) => x.item === item || (x.job !== undefined && s.jobs[x.job]?.item === item))) ev({ type: "user-done", key: n.key, byFactory: true });
      }
      ev({ type: "groups-moved", to, items });
      ev({ type: "note", text: `Split off to ${to}: ${c.reason}` });
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

const PLANNED = new Set<string>(["retry-job", "cancel-job", "resume-agent", "start-agent", "set-state", "redo-step", "edit-config", "shell", "hand-off", "split-request", "split-off", "move-groups", "fix-tests", "verify-stack"] satisfies PlannedCommand["cmd"][]);

export const STOPPED = "stopped by you";

// Your comments are shown on the patch with the summary of the run that answered them.
// Its draft replies to reviewers, which what it changes may make wrong.
function draftsNote(s: RequestState, item: ItemId): string {
  const drafts = Object.values(s.patches)
    .filter((p) => p.item === item)
    .flatMap((p) => p.replyDrafts.map((d) => ({ d, c: p.review?.comments.find((x) => x.id === d.commentId) })))
    .filter((x) => x.c && !x.c.done);
  if (!drafts.length) return "";
  return `\n\nYour draft replies to the reviewers, not posted yet:\n${drafts.map(({ d, c }) => `- comment ${d.commentId} (${c!.author}: “${c!.text.slice(0, 300)}”): ${d.text}`).join("\n")}\nIf what you change makes one wrong, give its new text in \`replies\` (by comment id).`;
}

// The lines of a section's text a comment is on (1-based, a line or a range).
export function sectionLines(text: string | undefined, line: number | [number, number] | undefined): string[] | undefined {
  if (text === undefined || line === undefined) return undefined;
  const [a, b] = typeof line === "number" ? [line, line] : line;
  const lines = text.split("\n").slice(a - 1, b);
  return lines.length ? lines : undefined;
}

// A comment from stack-viewer as an agent reads it: where, the words it's on, what you wrote.
export function commentLine(x: ReviewComment): string {
  const a = x.anchor;
  if (!a) return x.text;
  const lines = a.line === undefined ? "" : typeof a.line === "number" ? `line ${a.line}` : `lines ${a.line[0]}-${a.line[1]}`;
  const where = a.file === "(commit)" ? (lines ? `the commit message, ${lines}` : "the patch as a whole") : a.file === "(section:test-plan)" ? `the test plan${lines ? `, ${lines}` : ""}` : `${a.file}${a.line === undefined ? "" : `:${typeof a.line === "number" ? a.line : a.line.join("-")}`}${a.side === "old" ? " (the old side)" : ""}`;
  const text = x.text.includes("\n") ? `\n${quoted(x.text.split("\n"))}` : ` ${x.text}`;
  return `${where}${x.quote ? `, on "${x.quote}"` : ""}:${text}`;
}

function quoted(lines: string[]): string {
  return lines.map((l) => `  > ${l}`).join("\n");
}

const ANSWER_EACH ="Start the report's summary by answering each point of it in a line: what you changed, or, for a question or a change you didn't make, the answer and what backs it (the file, command or data you checked; for a shared helper, every test using it).";


