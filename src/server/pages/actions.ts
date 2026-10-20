import type { JobView, NeedsUser, PlannedCommand, PushView, RefusedCommand, RequestState, StackView } from "../../types.ts";
import { canDismiss, canRetry, reviewLimitFlag } from "../../state/flags.ts";
import { html, join, type Html } from "../html.ts";
import { actionKind, COMMAND_LABELS, commandFields, enterBugUrl, metaBugUrl, groupLabel, jobLabel, pushName, jobNoun, refusedOf, needsMetaBug, plural, requestUrl, stackOfPatch, submitChecks, type RenderContext } from "./common.ts";

// The ⚑ area of one open needs-user entry: what you're asked, why, and the buttons.
export function renderAction(r: RequestState, n: NeedsUser, ctx: RenderContext): Html {
  const plan = recoveryPlanFor(r, n);
  if (plan) {
    // What you said first, then its answer, what it would do, and what it asks you.
    return html`<div class="action reply" data-key="${n.key}"><span class="flag">You asked</span> <span class="said clamp1" data-expand title="${plan.text}">“${plan.text}”</span>${recoveryPlan(r, plan, requestUrl(r.id))}</div>`;
  }
  return html`<div class="action" data-key="${n.key}"><span class="flag">${flagTitle(r, n)}</span>${flagControls(r, n, ctx)}${actionKind(n, r) === "submit" ? null : why(n.detail)}</div>`;
}

// Under the title and its buttons, the whole width: one line, all of it when clicked.
function why(text: string | undefined): Html | null {
  return text ? html`<span class="why clamp1" data-expand title="${text}">${text}</span>` : null;
}

// A stopped job by its label rather than its tool or prompt name.
function flagTitle(r: RequestState, n: NeedsUser): string {
  const text = flagText(r, n);
  const item = n.item ?? (n.job === undefined ? undefined : r.jobs[n.job]?.item);
  return item !== undefined && item in r.items ? `${groupLabel(r, r.items[item])}: ${text}` : text.charAt(0).toUpperCase() + text.slice(1);
}

// What a ⚑ is about, with plain job names ("fetch test artifacts failed twice", not the tool's name).
export function flagText(r: RequestState, n: NeedsUser): string {
  const job = n.job === undefined ? undefined : r.jobs[n.job];
  if (n.item !== undefined && reviewLimitFlag(r, n.item) === n) {
    return "critical reviews didn't pass";
  }
  if (!job) {
    return n.push === undefined ? n.action : n.action.replace(n.push, pushName(r, n.push));
  }
  if (actionKind(n, r) === "stopped") {
    return `${jobNoun(job.name)} stopped by you`;
  }
  return n.action.includes(job.name) ? n.action.replace(job.name, jobNoun(job.name)) : n.action;
}

// The buttons of a ⚑ (also on its group row): every ⚑ has a way out.
export function flagControls(r: RequestState, n: NeedsUser, ctx: RenderContext): Html | null {
  const back = requestUrl(r.id);
  const job = n.job === undefined ? undefined : r.jobs[n.job];
  const item = n.item ?? job?.item;
  const retry = job && canRetry(r, job) ? retryButton(r.id, job, back) : null;
  const talk = item !== undefined && hasAuthorSession(r, item) ? continueBox(r.id, item, back) : null;
  const handBack = item === undefined ? null : handBackButton(r.id, item, back);
  let controls: Html | null = null;
  // Skips whose tests still fail: yes puts them back; anything else, say it to the author (fix them, say).
  if (n.key.startsWith("keep-skips:") && item !== undefined) {
    return buttons(
      commandButton(r.id, { cmd: "continue", item, text: "Yes, keep them: put exactly those skip-ifs back in your removal commit, change nothing else, and report it as `removal`." }, "Keep them", back, true, "Those failures stay unfixed, skipped as before"),
      talk,
    );
  }
  switch (actionKind(n, r)) {
    case "approve-push": {
      const push = n.push === undefined ? undefined : r.pushes[n.push];
      controls = push ? approvePushControls(r, [push], back) : null;
      break;
    }
    case "take-it": {
      const item = n.item;
      controls =
        item === undefined
          ? null
          : html`<form class="inline cmd" method="post" action="/api/commands">${commandFields([{ cmd: "take-it", request: r.id, item }], back)}<button class="btn small primary">Fix it anyway</button></form><form class="inline cmd" method="post" action="/api/commands">${commandFields([{ cmd: "hand-back", request: r.id, item }], back)}<button class="btn small">Leave it to them</button></form>`;
      break;
    }
    case "file-bug": {
      const patch = n.patch === undefined ? undefined : r.patches[n.patch];
      controls = patch?.bugDraft
        ? html`<a class="btn small" href="${enterBugUrl(patch.bugDraft, ctx)}" target="_blank" rel="noopener">Bug to file ↗</a>${bugBox(r.id, patch.id, back)}`
        : null;
      break;
    }
    case "meta-bug": {
      const draft = r.metaBug?.draft;
      const stack = findStack(r, n);
      controls = html`${draft ? html`<a class="btn small" href="${metaBugUrl(r, draft, ctx)}" target="_blank" rel="noopener">Meta: Bug to file ↗</a>` : null}${bugBox(r.id, "meta", back)}${stack ? submitControls(r, stack, back) : null}`;
      break;
    }
    // What it asks, in its buttons; the checks are on the stack, below.
    case "submit": {
      const stack = findStack(r, n);
      controls = stack ? html`${stackViewerLink(r, stack)}${mozPhabButton(r.id, stack, !submitChecks(r, stack)[0].ok)}` : null;
      break;
    }
    case "resubmit": {
      const stack = findStack(r, n);
      // Or decide against it (the patch lands as it is).
      controls = stack ? html`${mozPhabButton(r.id, stack, false)}${dismissButton(r.id, n.key, back)}` : null;
      break;
    }
    case "land": {
      const stack = findStack(r, n);
      controls = stack ? reorgButton(r.id, stack, n.key) : null;
      break;
    }
    case "failed": {
      // A critical review that ran but never said ok: the work is there, you judge it. A crashed one is retried.
      const accept = item !== undefined && reviewLimitFlag(r, item) === n;
      controls = buttons(
        accept ? commandButton(r.id, { cmd: "accept-review", item }, "Accept the patch as it is", back, true, "Takes the patch without another critical review") : retry,
        job?.kind === "agent" && !isAuthorJob(job) ? null : talk,
        accept ? null : handBack,
        // A script of the request's own (a try dry run, say) that later work made moot: a note, not a question.
        item === undefined && job?.kind !== "agent" ? dismissButton(r.id, n.key, back) : null,
      );
      break;
    }
    case "stopped":
      return buttons(retry, talk, handBack, dismissButton(r.id, n.key, back));
    case "disagrees":
      return buttons(talk, commandButton(r.id, { cmd: "dismiss", key: n.key }, "Go ahead with its patch", back, false, "Its patch goes on to critical review as it is"), handBack);
    case "recovery":
    case "other":
      break;
  }
  if (controls?.value) {
    return controls;
  }
  return canDismiss(n.key) ? dismissButton(r.id, n.key, back) : null;
}

function buttons(...list: (Html | null)[]): Html {
  return join(
    list.filter((x) => x !== null),
    "",
  );
}

// Continue resumes the author's session: there has to be one.
export function hasAuthorSession(r: RequestState, item: string): boolean {
  return r.items[item].jobs.some((j) => r.jobs[j].sessionId !== undefined && isAuthorJob(r.jobs[j]));
}

// Jobs folded before JobView had a purpose: their name tells.
export function isAuthorJob(j: JobView): boolean {
  return j.purpose?.what === "author" || j.name === "investigate-and-fix";
}

// A command the orchestrator refused, until you dismiss it or the same kind of command succeeds.
export function renderRefused(r: RequestState, x: RefusedCommand): Html {
  return html`<div class="action" data-key="${x.key}"><span class="flag">Your ${x.cmd ? COMMAND_LABELS[x.cmd] : "command"} was refused</span>${dismissButton(r.id, x.key, requestUrl(r.id))}${why(x.detail)}</div>`;
}

export function handBackButton(request: string, item: string, back: string): Html {
  return commandButton(request, { cmd: "hand-back", item }, "Hand back to me", back, false, "Closes the group: the factory stops working on it");
}

// An author with a session is resumed where it stopped; anything else runs again.
export function retryButton(request: string, job: JobView, back: string): Html {
  return job.kind === "agent" && job.sessionId && isAuthorJob(job)
    ? commandButton(request, { cmd: "retry", job: job.job }, "Resume", back, true, "Its author continues where it stopped")
    : commandButton(request, { cmd: "retry", job: job.job }, "Retry", back, true, `Runs ${jobNoun(job.name)} again`);
}

function commandButton(request: string, c: object, label: string, back: string, primary = false, title?: string): Html {
  return html`<form class="inline cmd" method="post" action="/api/commands">${commandFields([{ ...c, request }], back)}<button class="btn small${primary ? " primary" : ""}"${title ? html` title="${title}"` : null}>${label}</button></form>`;
}

export function pollPhabButton(request: string, back: string): Html {
  return commandButton(request, { cmd: "poll-phab" }, "Check Phabricator now", back, false, "Reviews, comments and statuses are otherwise checked every few hours");
}

export function redoAnnotationsButton(request: string, back: string): Html {
  return commandButton(request, { cmd: "redo-annotations" }, "Redo with today's skip-ifs", back, false, "Lists and classifies the folder's skip-ifs again, writes the patches and plans the un-skip push");
}

function dismissButton(request: string, key: string, back: string): Html {
  return commandButton(request, { cmd: "dismiss", key }, "Dismiss", back);
}

export function stopButton(request: string, job: string, back: string): Html {
  return commandButton(request, { cmd: "stop", job }, "Stop", back);
}

// Resumes the item's author with what you type.
export function continueBox(request: string, item: string, back: string): Html {
  return html`<form class="inline cmd" method="post" action="/api/commands">${commandFields([{ cmd: "continue", request, item }], back)}<input type="text" name="text" required placeholder="Tell its author what to do…"><button class="btn small" title="Resumes its author's session with your message; its patch then goes through lint and critical review again">Send to its author</button></form>`;
}

// The plan a recovery entry asks about: its job's latest plan, or the latest plan
// when it names no job.
export function recoveryPlanFor(r: RequestState, n: NeedsUser): RequestState["recoveryPlans"][number] | undefined {
  if (actionKind(n, r) !== "recovery") {
    return undefined;
  }
  return n.job === undefined ? r.recoveryPlans.at(-1) : r.recoveryPlans.findLast((p) => p.job === n.job);
}

function findStack(r: RequestState, n: NeedsUser): StackView | undefined {
  const stacks = Object.values(r.stacks);
  return (n.stack === undefined ? undefined : r.stacks[n.stack]) ?? stackOfPatch(r, n.patch) ?? (stacks.length === 1 ? stacks[0] : undefined);
}

// One button for these pushes; their commands and tasks are on their rows.
export function approvePushControls(r: RequestState, pushes: PushView[], back: string): Html {
  const label = pushes.length === 1 ? "Approve" : pushes.length === 2 ? "Approve both" : `Approve all ${pushes.length}`;
  return html`<form class="inline cmd" method="post" action="/api/commands">${commandFields(
    pushes.map((p) => ({ cmd: "approve-push", request: r.id, push: p.id })),
    back,
  )}<button class="btn small primary">${label}</button></form>`;
}

// One box for both answers to a bug draft: a number sets the bug, anything else
// is a comment for revise-bug-draft.md.
export function bugBox(request: string, patch: string, back: string, cls = "inline"): Html {
  return html`<form class="${cls} cmd" method="post" action="/api/commands">${commandFields([{ cmd: "set-bug", request, patch }], back)}<input type="text" name="bugOrText" required placeholder="${
    patch === "meta" ? "Paste the meta bug number, or comment on the draft" : "Paste the bug number, or comment on the draft"
  }"><button class="btn small">Send</button></form>`;
}

// The checks say what isn't ready yet; you decide, but a WIP or DEBUG commit is never submitted.
// Only the checks that fail, before the command: you decide, but a WIP or DEBUG commit is never submitted.
export function submitControls(r: RequestState, stack: StackView, back: string): Html {
  const checks = submitChecks(r, stack);
  const failing = checks.filter((c) => !c.ok);
  return html`${failing.length ? html`<span class="checks">${failing.map((c) => html`<span class="bad">${c.text}</span>`)}</span>` : null}${mozPhabButton(r.id, stack, !checks[0].ok)}`;
}

export function summaryId(request: string, stack: string): string {
  return `summary-${request}-${stack}`;
}

// Copies the value or text of the element with this id (see client.js).
export function copyButton(id: string, label: string, primary = false): Html {
  return html`<button type="button" class="btn small${primary ? " primary" : ""}" data-copy="${id}">${label}</button>`;
}

export function stackViewerLink(r: RequestState, stack: StackView): Html {
  return html`<a class="btn small" href="/requests/${encodeURIComponent(r.id)}/stacks/${encodeURIComponent(stack.id)}/review" target="_blank">Open in stack-viewer ↗</a>`;
}

// The factory never runs moz-phab: you copy the command and run it yourself.
// On the stack's branch: its worktree may have its try branch checked out.
export function mozPhabCommand(stack: StackView): string {
  return `cd ${stack.worktree} && git switch ${stack.branch} && moz-phab submit`;
}

// Copying it tells the factory to look for the revisions moz-phab creates.
// Copying it answers the ⚑.
function reorgButton(request: string, stack: StackView, key: string): Html {
  const id = `mozphab-reorg-${request}-${stack.id}`;
  return html`<form class="inline cmd" method="post" action="/api/commands">${commandFields([{ cmd: "copied-reorg", request, key }], requestUrl(request))}<textarea hidden id="${id}">cd ${stack.worktree} && git switch ${stack.branch} && moz-phab reorg</textarea><button type="button" class="btn small primary" data-copy="${id}">Copy the moz-phab reorg command</button></form>`;
}

function mozPhabButton(request: string, stack: StackView, disabled: boolean): Html {
  const id = `mozphab-${request}-${stack.id}`;
  return html`<form class="inline cmd" method="post" action="/api/commands">${commandFields([{ cmd: "copied-submit", request, stack: stack.id }], requestUrl(request))}<textarea hidden id="${id}">${mozPhabCommand(stack)}</textarea><button type="button" class="btn small primary" data-copy="${id}"${
    disabled ? html` disabled` : null
  }>Copy the moz-phab command</button></form>`;
}

// A planned command in plain words.
function plannedText(c: PlannedCommand, r: RequestState): string {
  switch (c.cmd) {
    case "retry-job":
      return `retry ${jobName(r, c.job)}`;
    case "cancel-job":
      return `stop ${jobName(r, c.job)}`;
    case "resume-agent":
      return `tell ${itemLabel(r, c.item)}’s author: “${c.message}”`;
    case "start-agent":
      return `restart the investigation of ${itemLabel(r, c.item)}: “${c.prompt}”`;
    case "set-state":
      return `mark ${itemLabel(r, c.item)} as ${c.state}`;
    case "redo-step":
      return `redo step ${c.step}${c.item ? ` for ${itemLabel(r, c.item)}` : ""}`;
    case "edit-config":
      return `change the request config: ${JSON.stringify(c.config)}`;
    case "shell":
      return `run in ${c.cwd}: ${c.command}`;
  }
}

export function plannedLabel(c: PlannedCommand, r: RequestState): Html {
  switch (c.cmd) {
    case "edit-config":
      return html`change the request config <code>${JSON.stringify(c.config)}</code>`;
    case "shell":
      return html`run in <code>${c.cwd}</code>: <code>${c.command}</code>`;
    default:
      return html`${plannedText(c, r)}`;
  }
}

// The job's label, and its group when it has one. A plan can name a job the state doesn't have.
function jobName(r: RequestState, id: string): string {
  const j = r.jobs[id];
  if (!j) {
    return id;
  }
  if (j.item === undefined) {
    return jobLabel(j.name);
  }
  return j.name === "investigate-and-fix" ? `the investigation of ${itemLabel(r, j.item)}` : `${jobLabel(j.name)} of ${itemLabel(r, j.item)}`;
}

// What you told the factory, on one line; the full text in the title.
export function youSaid(text: string): Html {
  return html`<span class="why clamp1" title="${text}">${text}</span>`;
}

function itemLabel(r: RequestState, item: string): string {
  const v = r.items[item];
  return v ? (v.group.tests.length === 1 ? (v.group.tests[0].split("/").pop() ?? item) : v.folder) : item;
}

export function recoveryPlan(r: RequestState, plan: RequestState["recoveryPlans"][number], back: string): Html {
  return html`${plan.answer ? html`<p class="answer">${plan.answer}</p>` : null}${
    plan.plan.length
      ? html`<form class="inline cmd" method="post" action="/api/commands"><input type="hidden" name="back" value="${back}"><ul class="plan">${plan.plan.map(
          (c, i) =>
            // The shell escape hatch is opt-in; everything else is checked. An agent's instructions are folded.
            html`<li><label><input type="checkbox" name="command" value="${JSON.stringify({ ...c, request: r.id })}"${c.cmd === "shell" ? null : html` checked`}> ${shortLabel(c, r)}</label> <span class="reason">${c.reason}</span>${
              instructions(c) ? html`<details class="fold" data-fold="plan-${plan.job}-${i}"><summary>its instructions</summary><div class="sub">${instructions(c)}</div></details>` : null
            }</li>`,
        )}</ul><button class="btn small primary">${plan.plan.length === 1 ? "Do it" : "Do these"}</button></form>`
      : null
  }${plan.questions.length ? html`<ul class="plan-notes">${plan.questions.map((t) => html`<li>❓ ${t}</li>`)}</ul>` : null}${
    plan.cannotDo.length ? html`<details class="fold" data-fold="cannot-${plan.job}"><summary>${plural(plan.cannotDo.length, "thing")} it can't do</summary><ul class="plan-notes">${plan.cannotDo.map((t) => html`<li>${t}</li>`)}</ul></details>` : null
  }<form class="inline cmd" method="post" action="/api/commands">${commandFields([{ cmd: "reply-recovery", request: r.id, job: plan.job }], back)}<input type="text" name="text" required placeholder="${plan.questions.length ? "Answer it, or say what to change…" : "Say what to change…"}"><button class="btn small">Reply</button></form>`;
}

// What a command does, without the text it hands an agent.
function shortLabel(c: PlannedCommand, r: RequestState): Html {
  switch (c.cmd) {
    case "resume-agent":
      return html`tell ${itemLabel(r, c.item)}’s author`;
    case "start-agent":
      return html`restart the investigation of ${itemLabel(r, c.item)}`;
    default:
      return plannedLabel(c, r);
  }
}

function instructions(c: PlannedCommand): string | undefined {
  return c.cmd === "resume-agent" ? c.message : c.cmd === "start-agent" ? c.prompt : undefined;
}

// A group's ⚑ is handled on its row, a try push's on its row too; the request's own ⚑s (recovery plans,
// meta bug, submit…) here, under its name.
export function actionsSummary(r: RequestState, ctx: RenderContext): Html {
  return join([...r.needsUser.filter((n) => flagItemOf(r, n) === undefined && !isPushApproval(r, n) && !recoveryPlanFor(r, n)).map((n) => renderAction(r, n, ctx)), ...refusedOf(r).map((x) => renderRefused(r, x))], "");
}

// Answers to what you typed in the request's box go right above that box, in its body: folds there open.
export function recoveryAnswers(r: RequestState, ctx: RenderContext): Html {
  return join(r.needsUser.filter((n) => recoveryPlanFor(r, n)).map((n) => renderAction(r, n, ctx)), "");
}

// A planned push is approved on its row of the request's try pushes.
export function isPushApproval(r: RequestState, n: NeedsUser): boolean {
  return actionKind(n, r) === "approve-push" && n.push !== undefined && n.push in r.pushes && !r.pushes[n.push].rev;
}

// The group a ⚑ is about: its item, or its job's.
export function flagItemOf(r: RequestState, n: NeedsUser): string | undefined {
  const item = n.item ?? (n.job === undefined ? undefined : r.jobs[n.job]?.item);
  return item !== undefined && item in r.items ? item : undefined;
}
