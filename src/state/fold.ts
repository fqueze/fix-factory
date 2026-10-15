// Folds a request's events into its current state. Pure: no I/O, the input isn't mutated.
//
// Semantics worth knowing:
// - A patch event is the full current record of that patch: the latest one replaces
//   every patch field (deps, review and reply drafts are kept, they come from other events).
// - config-set replaces the whole config.
// - deps, review status and reply drafts may arrive before their patch event; they are
//   attached once the patch exists.
// - Events for an unknown push create it (a try-push request starts from an existing push).
//   Events for unknown items are ignored, as are unknown event types.
// - pushes keep creation order as long as push ids aren't integer-like strings
//   (JavaScript orders those keys first).
import type { Dep, Event, ItemView, PatchView, PushView, RequestState } from "../types.ts";

type Review = NonNullable<PatchView["review"]>;

export function foldEvents(events: readonly Event[]): RequestState {
  if (events.length === 0) {
    throw new Error("foldEvents: no events");
  }
  const first = events[0];
  const s: RequestState = {
    id: first.request,
    kind: "burndown",
    text: "",
    createdAt: first.t,
    updatedAt: first.t,
    step: "request",
    config: {},
    items: {},
    patches: {},
    stacks: {},
    pushes: {},
    jobs: {},
    needsUser: [],
    recoveryPlans: [],
    notes: [],
  };
  const deps = new Map<string, Dep[]>();
  const reviews = new Map<string, Review>();
  const replies = new Map<string, Map<number, string>>();

  const push = (id: string): PushView => (s.pushes[id] ??= { id, purpose: "", command: [] });

  for (const e of events) {
    switch (e.type) {
      case "request-created":
        s.id = e.request;
        s.kind = e.kind;
        s.text = e.text;
        s.folder = e.folder;
        s.rev = e.rev;
        s.createdAt = e.t;
        break;
      case "config-set":
        s.config = e.config;
        break;
      case "step":
        s.step = e.step;
        break;
      case "item-created": {
        const existing = s.items[e.item];
        if (existing) {
          existing.folder = e.folder;
          existing.group = e.group;
        } else {
          s.items[e.item] = { id: e.item, folder: e.folder, group: e.group, state: "not started", jobs: [] };
        }
        break;
      }
      case "item-state": {
        const item = s.items[e.item];
        if (!item) continue;
        item.state = e.state;
        if (e.detail === undefined) {
          delete item.detail;
        } else {
          item.detail = e.detail;
        }
        break;
      }
      case "job-started": {
        s.jobs[e.job] = {
          job: e.job,
          item: e.item,
          kind: e.kind,
          name: e.name,
          cmd: e.cmd,
          cwd: e.cwd,
          pid: e.pid,
          pidStartTime: e.pidStartTime,
          startedAt: e.t,
          model: e.model,
          sessionId: e.sessionId,
        };
        const item = e.item === undefined ? undefined : s.items[e.item];
        if (item && !item.jobs.includes(e.job)) {
          item.jobs.push(e.job);
        }
        break;
      }
      case "job-finished": {
        const job = s.jobs[e.job];
        if (!job) continue;
        job.endedAt = e.t;
        job.exitCode = e.exitCode;
        job.durationMs = e.durationMs;
        job.costUsd = e.costUsd;
        job.error = e.error;
        break;
      }
      case "agent-report": {
        const itemId = e.item ?? s.jobs[e.job]?.item;
        const item: ItemView | undefined = itemId === undefined ? undefined : s.items[itemId];
        if (!item) continue;
        item.lastReport = { prompt: e.prompt, report: e.report, job: e.job };
        break;
      }
      case "patch":
        s.patches[e.patch] = {
          id: e.patch,
          item: e.item,
          sha: e.sha,
          worktree: e.worktree,
          title: e.title,
          bug: e.bug,
          bugDraft: e.bugDraft,
          revision: e.revision,
          effort: e.effort,
          testOnly: e.testOnly,
          interdiffFile: e.interdiffFile,
          deps: [],
          replyDrafts: [],
        };
        break;
      case "dep": {
        const list = (deps.get(e.dep.patch) ?? []).filter((d) => d.needs !== e.dep.needs);
        list.push(e.dep);
        deps.set(e.dep.patch, list);
        break;
      }
      case "dep-removed": {
        const list = deps.get(e.patch);
        if (!list) continue;
        deps.set(
          e.patch,
          list.filter((d) => d.needs !== e.needs),
        );
        break;
      }
      case "stack":
        s.stacks[e.stack] = {
          id: e.stack,
          folder: e.folder,
          branch: e.branch,
          worktree: e.worktree,
          base: e.base,
          order: e.order,
          summary: e.summary,
        };
        break;
      case "try-planned": {
        const p = push(e.push);
        p.purpose = e.purpose;
        p.command = e.command;
        p.taskCount = e.taskCount;
        break;
      }
      case "try-pushed": {
        const p = push(e.push);
        p.rev = e.rev;
        p.url = e.url;
        break;
      }
      case "try-progress":
        push(e.push).progress = { done: e.done, total: e.total, failures: e.failures };
        break;
      case "try-finished": {
        const p = push(e.push);
        p.result = e.result;
        p.summary = e.summary;
        break;
      }
      case "review-status":
        reviews.set(e.patch, { revision: e.revision, status: e.status, reviewers: e.reviewers, comments: e.comments });
        break;
      case "reply-draft": {
        const m = replies.get(e.patch) ?? new Map<number, string>();
        m.set(e.commentId, e.text);
        replies.set(e.patch, m);
        break;
      }
      case "needs-user": {
        const open = s.needsUser.find((n) => n.key === e.key);
        const n = { key: e.key, action: e.action, detail: e.detail, item: e.item, patch: e.patch, push: e.push, stack: e.stack, job: e.job };
        if (open) {
          // Re-raising keeps the original since: it measures how long you've been needed.
          Object.assign(open, n);
        } else {
          s.needsUser.push({ ...n, since: e.t });
        }
        break;
      }
      case "meta-bug":
        s.metaBug = { bug: e.bug, draft: e.draft };
        break;
      case "user-done":
        s.needsUser = s.needsUser.filter((n) => n.key !== e.key);
        break;
      case "command-executed":
        break;
      case "recovery-plan":
        s.recoveryPlans.push({ job: e.job, text: e.text, plan: e.plan, cannotDo: e.cannotDo, questions: e.questions, t: e.t });
        break;
      case "note":
        s.notes.push({ t: e.t, text: e.text });
        break;
      default:
        continue;
    }
    s.updatedAt = e.t;
  }

  for (const p of Object.values(s.patches)) {
    p.deps = deps.get(p.id) ?? [];
    const review = reviews.get(p.id);
    if (review) {
      p.review = review;
    }
    p.replyDrafts = [...(replies.get(p.id) ?? [])].map(([commentId, text]) => ({ commentId, text }));
  }
  return stripUndefined(s);
}

// Deep-copies the state, so it shares no objects with the input events (the fold
// above assigns event objects and arrays directly), and drops undefined optional
// fields, which would otherwise make deepEqual comparisons and JSON round trips disagree.
function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(stripUndefined) as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = stripUndefined(v);
    }
    return out as T;
  }
  return value;
}
