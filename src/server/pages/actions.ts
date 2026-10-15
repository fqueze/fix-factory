import type { NeedsUser, PlannedCommand, PushView, RefusedCommand, RequestState, StackView } from "../../types.ts";
import { canDismiss, isPushJob, reviewLimitFlag } from "../../state/flags.ts";
import { html, join, type Html } from "../html.ts";
import { actionKind, COMMAND_LABELS, commandFields, enterBugUrl, groupLabel, isStackedItem, jobLabel, jobNoun, refusedOf, requestUrl, stackOfPatch, submitChecks } from "./common.ts";

// The ⚑ area of one open needs-user entry: what you're asked, why, and the buttons.
export function renderAction(r: RequestState, n: NeedsUser): Html {
  const plan = recoveryPlanFor(r, n);
  if (plan) {
    return html`<div class="action" data-key="${n.key}"><span class="flag">${n.action}</span> ${youSaid(n.detail || `You said: “${plan.text}”`)}${recoveryPlan(r, plan, requestUrl(r.id))}</div>`;
  }
  return html`<div class="action" data-key="${n.key}"><span class="flag">${flagTitle(r, n)}</span> <span class="why">${n.detail}</span>${flagControls(r, n)}</div>`;
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
    return n.action;
  }
  if (actionKind(n, r) === "stopped") {
    return `${jobNoun(job.name)} stopped by you`;
  }
  return n.action.includes(job.name) ? n.action.replace(job.name, jobNoun(job.name)) : n.action;
}

// The buttons of a ⚑ (also on its group row): every ⚑ has a way out.
export function flagControls(r: RequestState, n: NeedsUser): Html | null {
  const back = requestUrl(r.id);
  const job = n.job === undefined ? undefined : r.jobs[n.job];
  const item = n.item ?? job?.item;
  const retry = job && !isPushJob(job) ? commandButton(r.id, { cmd: "retry", job: job.job }, "Retry", back, false, `Runs ${jobNoun(job.name)} again`) : null;
  const talk = item !== undefined && hasAuthorSession(r, item) ? continueBox(r.id, item, back) : null;
  let controls: Html | null = null;
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
          : html`<form class="inline cmd" method="post" action="/api/commands">${commandFields([{ cmd: "take-it", request: r.id, item }], back)}<button class="btn small primary">Take it</button></form><form class="inline cmd" method="post" action="/api/commands">${commandFields([{ cmd: "hand-back", request: r.id, item }], back)}<button class="btn small">Hand back</button></form>`;
      break;
    }
    case "file-bug": {
      const patch = n.patch === undefined ? undefined : r.patches[n.patch];
      controls = patch?.bugDraft
        ? html`<a class="btn small" href="${enterBugUrl(patch.bugDraft)}" target="_blank" rel="noopener">Bug to file ↗</a>${bugBox(r.id, patch.id, back)}`
        : null;
      break;
    }
    case "meta-bug": {
      const draft = r.metaBug?.draft;
      const stack = findStack(r, n);
      controls = html`${draft ? html`<a class="btn small" href="${enterBugUrl(draft)}" target="_blank" rel="noopener">Meta: Bug to file ↗</a>` : null}${bugBox(r.id, "meta", back)}${stack ? submitControls(r, stack, back) : null}`;
      break;
    }
    case "submit": {
      const stack = findStack(r, n);
      controls = stack ? submitControls(r, stack, back) : null;
      break;
    }
    case "resubmit":
    case "land": {
      const stack = findStack(r, n);
      controls = stack ? mozPhabButton(r.id, stack, false) : null;
      break;
    }
    case "failed": {
      // A critical review that ran but never said ok: the work is there, you judge it. A crashed one is retried.
      const accept = item !== undefined && reviewLimitFlag(r, item) === n;
      controls = buttons(talk, accept ? commandButton(r.id, { cmd: "accept-review", item }, "Accept as reviewed", back, false, "Takes the patch as it is, without another critical review") : retry);
      break;
    }
    case "stopped":
      return buttons(talk, retry, dismissButton(r.id, n.key, back));
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
  // Jobs folded before JobView had a purpose: their name tells.
  return r.items[item].jobs.some((j) => r.jobs[j].sessionId !== undefined && (r.jobs[j].purpose?.what === "author" || r.jobs[j].name === "investigate-and-fix"));
}

// A command the orchestrator refused, until you dismiss it or the same kind of command succeeds.
export function renderRefused(r: RequestState, x: RefusedCommand): Html {
  return html`<div class="action" data-key="${x.key}"><span class="flag">Your ${x.cmd ? COMMAND_LABELS[x.cmd] : "command"} was refused</span> <span class="why">${x.detail ?? ""}</span>${dismissButton(r.id, x.key, requestUrl(r.id))}</div>`;
}

function commandButton(request: string, c: object, label: string, back: string, primary = false, title?: string): Html {
  return html`<form class="inline cmd" method="post" action="/api/commands">${commandFields([{ ...c, request }], back)}<button class="btn small${primary ? " primary" : ""}"${title ? html` title="${title}"` : null}>${label}</button></form>`;
}

function dismissButton(request: string, key: string, back: string): Html {
  return commandButton(request, { cmd: "dismiss", key }, "Dismiss", back);
}

export function stopButton(request: string, job: string, back: string): Html {
  return commandButton(request, { cmd: "stop", job }, "Stop", back);
}

// Resumes the item's author with what you type.
export function continueBox(request: string, item: string, back: string): Html {
  return html`<form class="inline cmd" method="post" action="/api/commands">${commandFields([{ cmd: "continue", request, item }], back)}<input type="text" name="text" required placeholder="Tell its author what to do…"><button class="btn small primary" title="Resumes its author's session with your message; its patch then goes through lint and critical review again">Continue</button></form>`;
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

export function approvePushControls(r: RequestState, pushes: PushView[], back: string): Html {
  const label = pushes.length === 1 ? "Approve" : pushes.length === 2 ? "Approve both" : `Approve all ${pushes.length}`;
  return html`<form class="inline cmd" method="post" action="/api/commands">${commandFields(
    pushes.map((p) => ({ cmd: "approve-push", request: r.id, push: p.id })),
    back,
  )}<button class="btn small primary">${label}</button></form>${pushes.map((p) => commandDetails(p, pushes.length === 1 ? "Command + tasks" : `Command ${p.id}`))}`;
}

export function commandDetails(p: PushView, label = "Command"): Html {
  return html`<details class="cmdline"><summary class="btn small">${label}</summary><pre class="mono">${p.command.join(" ")}</pre>${p.taskCount === undefined ? null : html`<div class="sub">${p.taskCount} tasks</div>`}</details>`;
}

// One box for both answers to a bug draft: a number sets the bug, anything else
// is a comment for revise-bug-draft.md.
export function bugBox(request: string, patch: string, back: string, cls = "inline"): Html {
  return html`<form class="${cls} cmd" method="post" action="/api/commands">${commandFields([{ cmd: "set-bug", request, patch }], back)}<input type="text" name="bugOrText" required placeholder="${
    patch === "meta" ? "Paste the meta bug number, or comment on the draft" : "Paste the bug number, or comment on the draft"
  }"><button class="btn small">Send</button></form>`;
}

export function submitControls(r: RequestState, stack: StackView, back: string): Html {
  const checks = submitChecks(r, stack);
  const ready = checks.every((c) => c.ok);
  return html`<div class="checks" style="flex-basis:100%">${checks.map((c) => html`<span class="${c.ok ? "ok" : "bad"}">${c.text}</span>`)}</div>${stackViewerLink(stack)}${mozPhabButton(r.id, stack, !ready)}${
    stack.summary
      ? html`<textarea hidden id="${summaryId(r.id, stack.id)}">${stack.summary}</textarea>${copyButton(summaryId(r.id, stack.id), "Copy the meta-bug comment")}`
      : null
  }`;
}

export function summaryId(request: string, stack: string): string {
  return `summary-${request}-${stack}`;
}

// Copies the value or text of the element with this id (see client.js).
export function copyButton(id: string, label: string, primary = false): Html {
  return html`<button type="button" class="btn small${primary ? " primary" : ""}" data-copy="${id}">${label}</button>`;
}

export function stackViewerLink(stack: StackView): Html {
  return html`<a class="btn small" href="/stacks/${encodeURIComponent(stack.id)}/review" target="_blank">Open in stack-viewer ↗</a>`;
}

// The factory never runs moz-phab: you copy the command and run it yourself.
export function mozPhabCommand(stack: StackView): string {
  return `cd ${stack.worktree} && moz-phab submit`;
}

function mozPhabButton(request: string, stack: StackView, disabled: boolean): Html {
  const id = `mozphab-${request}-${stack.id}`;
  return html`<textarea hidden id="${id}">${mozPhabCommand(stack)}</textarea><button type="button" class="btn small primary" data-copy="${id}"${
    disabled ? html` disabled` : null
  }>Copy the moz-phab command</button>`;
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

function plannedLabel(c: PlannedCommand, r: RequestState): Html {
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
  return html`<form class="inline cmd" method="post" action="/api/commands"><input type="hidden" name="back" value="${back}"><ul class="plan">${plan.plan.map(
    (c) =>
      // The shell escape hatch is opt-in; everything else is checked.
      html`<li><label title="${plannedText(c, r)}"><input type="checkbox" name="command" value="${JSON.stringify({ ...c, request: r.id })}"${c.cmd === "shell" ? null : html` checked`}> ${plannedLabel(c, r)}</label><span class="reason clamp1" data-expand>${c.reason}</span></li>`,
  )}</ul>${plan.plan.length ? html`<button class="btn small primary">Run checked</button>` : null}</form>${
    plan.cannotDo.length || plan.questions.length
      ? html`<ul class="plan-notes">${plan.cannotDo.map((t) => html`<li>✋ Can't do: ${t}</li>`)}${plan.questions.map((t) => html`<li>❓ ${t}</li>`)}</ul>`
      : null
  }<form class="inline cmd" method="post" action="/api/commands">${commandFields([{ cmd: "reply-recovery", request: r.id, job: plan.job }], back)}<input type="text" name="text" required placeholder="Reply…"><button class="btn small">Reply</button></form>`;
}

// A group's ⚑ is handled on its row: the request header only points at it. The request's own ⚑s
// (try approvals, recovery plans, meta bug, submit…) are handled here.
export function actionsSummary(r: RequestState): Html {
  return join(
    [
      ...r.needsUser.map((n) => {
        const item = flagItem(r, n);
        return item === undefined
          ? renderAction(r, n)
          : html`<div class="action pointer" data-key="${n.key}"><a class="flag" href="${requestUrl(r.id)}#item-${item}">${flagTitle(r, n)}</a></div>`;
      }),
      ...refusedOf(r).map((x) => renderRefused(r, x)),
    ],
    "",
  );
}

// The group row a ⚑ is handled on; none when the group is shown by a stack (the ⚑ keeps its buttons in the header).
function flagItem(r: RequestState, n: NeedsUser): string | undefined {
  const item = n.item ?? (n.job === undefined ? undefined : r.jobs[n.job]?.item);
  return item !== undefined && item in r.items && !isStackedItem(r, item) ? item : undefined;
}
