import type { NeedsUser, PlannedCommand, PushView, RequestState, StackView } from "../../types.ts";
import { html, join, type Html } from "../html.ts";
import { actionKind, commandFields, enterBugUrl, requestUrl, stackOfPatch, submitChecks } from "./common.ts";

// The ⚑ area of one open needs-user entry: what you're asked, why, and the buttons.
export function renderAction(r: RequestState, n: NeedsUser): Html {
  const kind = actionKind(n, r);
  const back = requestUrl(r.id);
  let controls: Html | null = null;
  switch (kind) {
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
      controls = stack ? mozPhabButton(r.id, stack, back, false) : null;
      break;
    }
    case "recovery": {
      const plan = recoveryPlanFor(r, n);
      return plan
        ? html`<div class="action" data-key="${n.key}"><span class="flag">${n.action}</span><span class="why">${n.detail || html`You said: “${plan.text}”`}</span>${recoveryPlan(r, plan, back)}</div>`
        : html`<div class="action" data-key="${n.key}"><span class="flag">${n.action}</span><span class="why">${n.detail}</span></div>`;
    }
    case "other":
      break;
  }
  return html`<div class="action" data-key="${n.key}"><span class="flag">${n.action}</span><span class="why">${n.detail}</span>${controls}</div>`;
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
  return html`<div class="checks" style="flex-basis:100%">${checks.map((c) => html`<span class="${c.ok ? "ok" : "bad"}">${c.text}</span>`)}</div>${stackViewerLink(stack)}${mozPhabButton(r.id, stack, back, !ready)}${
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

function mozPhabButton(request: string, stack: StackView, back: string, disabled: boolean): Html {
  return html`<form class="inline cmd" method="post" action="/api/commands">${commandFields([{ cmd: "run-moz-phab", request, stack: stack.id, args: ["submit"] }], back)}<button class="btn small primary"${
    disabled ? html` disabled` : null
  }>moz-phab submit</button></form>`;
}

function plannedTarget(c: PlannedCommand, r: RequestState): string {
  switch (c.cmd) {
    case "retry-job":
    case "cancel-job":
      return r.jobs[c.job]?.name ?? c.job;
    case "resume-agent":
      return `${itemLabel(r, c.item)}: “${c.message}”`;
    case "start-agent":
      return `${itemLabel(r, c.item)}: ${c.prompt}`;
    case "set-state":
      return `${itemLabel(r, c.item)} → ${c.state}`;
    case "redo-step":
      return c.item ? `${itemLabel(r, c.item)}: ${c.step}` : c.step;
    case "edit-config":
      return JSON.stringify(c.config);
    case "shell":
      return `${c.cwd}$ ${c.command}`;
  }
}

function itemLabel(r: RequestState, item: string): string {
  const v = r.items[item];
  return v ? (v.group.tests.length === 1 ? (v.group.tests[0].split("/").pop() ?? item) : v.folder) : item;
}

export function recoveryPlan(r: RequestState, plan: RequestState["recoveryPlans"][number], back: string): Html {
  return html`<form class="inline cmd" method="post" action="/api/commands"><input type="hidden" name="back" value="${back}"><ul>${plan.plan.map(
    (c) =>
      // The shell escape hatch is opt-in; everything else is checked.
      html`<li><label><input type="checkbox" name="command" value="${JSON.stringify({ ...c, request: r.id })}"${c.cmd === "shell" ? null : html` checked`}> <code>${c.cmd}</code> ${
        c.cmd === "shell" ? html`<code>${plannedTarget(c, r)}</code>` : plannedTarget(c, r)
      } <span class="sub">${c.reason}</span></label></li>`,
  )}${plan.cannotDo.map((t) => html`<li>✋ Can't do: ${t}</li>`)}${plan.questions.map((t) => html`<li>❓ ${t}</li>`)}</ul>${
    plan.plan.length ? html`<button class="btn small primary">Run checked</button>` : null
  }</form><form class="inline cmd" method="post" action="/api/commands">${commandFields([{ cmd: "reply-recovery", request: r.id, job: plan.job }], back)}<input type="text" name="text" required placeholder="Reply…"><button class="btn small">Reply</button></form>`;
}

export function actionsSummary(r: RequestState): Html {
  return join(r.needsUser.map((n) => renderAction(r, n)), "");
}
