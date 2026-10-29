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
import type { Dep, Event, InvestigateReport, ItemView, PatchView, PushView, RefusedCommand, RequestState, TriageTryReport } from "../types.ts";

const MAX_REFUSED = 5;

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
    patchSent: {},
    bugLandings: {},
    backouts: {},
    patchShas: {},
    pushChanges: {},
    jobs: {},
    needsUser: [],
    recoveryPlans: [],
    handOffs: [],
    notes: [],
  };
  const deps = new Map<string, Dep[]>();
  const reviews = new Map<string, Review>();
  const replies = new Map<string, Map<number, string>>();
  let refused: RefusedCommand[] = [];

  const push = (id: string): PushView => (s.pushes[id] ??= { id, purpose: "", command: [] });

  for (const e of events) {
    switch (e.type) {
      case "request-created":
        s.id = e.request;
        s.kind = e.kind;
        s.text = e.text;
        s.folder = e.folder;
        s.rev = e.rev;
        s.fromCommand = e.command;
        s.createdAt = e.t;
        break;
      case "request-forwarded":
        s.forwardedTo = e.to;
        break;
      case "request-superseded":
        s.supersededBy = e.by;
        break;
      case "request-split":
        s.splitInto = e.into;
        if (e.moved) s.movedTo = e.moved;
        break;
      case "split-from":
        s.splitFrom = e.from;
        break;
      case "comment-sent":
        // One per answering run: a later event for it corrects the earlier one.
        if (s.patches[e.patch]) s.patches[e.patch].yourComments = [...(s.patches[e.patch].yourComments ?? []).filter((c) => c.key !== e.key), { text: e.text, key: e.key, t: e.t }];
        break;
      case "author-queued":
        s.queuedAuthors = [...(s.queuedAuthors ?? []), { item: e.item, key: e.key, reason: e.reason, message: e.message }];
        break;
      case "landing-status":
        s.bugLandings[e.bug] = { status: e.status, at: e.at, ...(e.reason ? { reason: e.reason } : {}) };
        break;
      case "backout":
        s.backouts[e.patch] = { at: e.at, reason: e.reason, culprit: e.culprit };
        break;
      case "backout-verified":
        if (s.backouts[e.patch]) s.backouts[e.patch].verified = true;
        break;
      case "verify-asked":
        s.verifyAsked = [...(s.verifyAsked ?? []), e.text];
        break;
      case "tests-asked":
        s.askedTests = [...new Set([...(s.askedTests ?? []), ...e.tests])];
        break;
      case "meta-draft-asked":
        s.metaDraftAsked = true;
        break;
      case "groups-moved":
        s.movedTo = { ...s.movedTo, ...Object.fromEntries(e.items.map((i) => [i, e.to])) };
        break;
      case "request-routed":
        s.kind = e.kind;
        s.folder = e.folder;
        s.rev = e.rev;
        break;
      case "config-set":
        s.config = e.config;
        break;
      case "step":
        s.step = e.step;
        if (e.step === "done") s.finishedAt = e.t;
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
      case "item-group":
        if (s.items[e.item]) s.items[e.item].group = e.group;
        break;
      case "item-state": {
        const item = s.items[e.item];
        if (!item) continue;
        item.state = e.state;
        if (e.coveredBy === undefined) delete item.coveredBy;
        else item.coveredBy = e.coveredBy;
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
          purpose: e.purpose,
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
        if (e.machProfiles) job.machProfiles = e.machProfiles;
        break;
      }
      case "agent-report": {
        const job = s.jobs[e.job];
        const outcome = outcomeOf(e.report);
        if (job && outcome) job.outcome = outcome;
        const r = e.report as { summary?: unknown; disagreement?: unknown; answer?: unknown } | null;
        const said = typeof r?.disagreement === "string" ? `Disagrees with you: ${r.disagreement}` : typeof r?.answer === "string" ? r.answer : typeof r?.summary === "string" ? r.summary : undefined;
        if (job && said) job.said = said;
        // A push's failures as triage saw them; a later run of the same cell replaces the earlier verdict.
        if (e.prompt === "triage-try" && job?.purpose?.push !== undefined && s.pushes[job.purpose.push]) {
          const p = s.pushes[job.purpose.push];
          const cells = (e.report as TriageTryReport).cells;
          const at = (c: TriageTryReport["cells"][number]) => `${c.test ?? c.taskId}\n${c.config}`;
          p.analysis = [...(p.analysis ?? []).filter((c) => !cells.some((n) => at(n) === at(c))), ...cells];
        }
        const itemId = e.item ?? job?.item;
        const item: ItemView | undefined = itemId === undefined ? undefined : s.items[itemId];
        if (!item) {
          if (!job) continue;
          break;
        }
        item.lastReport = { prompt: e.prompt, report: e.report, job: e.job };
        if (e.prompt === "investigate-and-fix") item.investigation = e.report as InvestigateReport;
        // Its fix's commits: a patch beyond them is one its author dropped (or squashed away).
        const fix = e.report as { state?: string; commits?: string[] };
        if ((e.prompt === "investigate-and-fix" && fix.state === "fix verified locally") || e.prompt === "address-review") item.commitCount = fix.commits?.length;
        break;
      }
      case "patch": {
        // When its revision first showed up: what its author changes after that has to be resubmitted.
        const before = s.patches[e.patch];
        if (!(s.patchShas[e.patch] ?? []).includes(e.sha)) s.patchShas[e.patch] = [...(s.patchShas[e.patch] ?? []), e.sha];
        const submittedAt = e.revision === undefined ? undefined : before?.revision !== undefined ? before.submittedAt : e.t;
        // The commit Phabricator has: the one its revision showed up on, then what you copied the moz-phab command for.
        const sentSha = e.revision === undefined ? undefined : before?.revision !== undefined ? before.sentSha : e.sha;
        if (sentSha !== undefined && before?.sentSha !== sentSha) s.patchSent[e.patch] = [...(s.patchSent[e.patch] ?? []), { sha: sentSha, t: e.t }];
        s.patches[e.patch] = {
          id: e.patch,
          item: e.item,
          sha: e.sha,
          worktree: e.worktree,
          title: e.title,
          bug: e.bug,
          ...(e.bugFromYou ? { bugFromYou: true } : {}),
          bugDraft: e.bugDraft,
          revision: e.revision,
          effort: e.effort,
          testOnly: e.testOnly,
          interdiffFile: e.interdiffFile,
          ...(submittedAt ? { submittedAt } : {}),
          ...(sentSha ? { sentSha } : {}),
          // Its commit's earlier shas (before rebases and rewrites): what agents may still call it by.
          pastShas: before && before.sha !== e.sha ? [...(before.pastShas ?? []), before.sha] : before?.pastShas,
          deps: [],
          replyDrafts: [],
          ...(before?.testPlan ? { testPlan: before.testPlan } : {}),
          ...(before?.testPlanSent ? { testPlanSent: before.testPlanSent } : {}),
        };
        break;
      }
      case "push-changes":
        s.pushChanges[e.stack] = { since: e.since, changes: e.changes, removed: e.removed };
        break;
      case "try-context": {
        const p = push(e.push);
        if (e.since !== undefined) p.since = e.since;
        if (e.regressions !== undefined) p.regressions = e.regressions;
        if (e.scope !== undefined) p.scope = e.scope;
        break;
      }
      case "test-plan":
        // Phabricator doesn't render code in link text: [`foo.js`](url) becomes [foo.js](url), earlier plans included.
        if (s.patches[e.patch]) s.patches[e.patch].testPlan = e.text.replace(/\[`([^`\]]+)`\]\(/g, "[$1](");
        break;
      case "reviewer-set":
        if (s.patches[e.patch]) s.patches[e.patch].reviewerFromYou = e.reviewer;
        break;
      case "hand-off":
        s.handOffs.push({ job: e.job, items: e.items, text: e.text, t: e.t });
        break;
      case "test-plan-sent":
        if (s.patches[e.patch]) s.patches[e.patch].testPlanSent = { revision: e.revision, text: e.text, t: e.t };
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
      case "stack-dropped":
        delete s.stacks[e.stack];
        break;
      case "stack":
        s.stacks[e.stack] = {
          id: e.stack,
          folder: e.folder,
          branch: e.branch,
          worktree: e.worktree,
          base: e.base,
          order: e.order,
          summary: e.summary,
          submitCopied: s.stacks[e.stack]?.submitCopied,
          submittedOrder: s.stacks[e.stack]?.submittedOrder,
        };
        break;
      case "poll-requested":
        s.pollRequested = e.t;
        break;
      case "submit-copied":
        if (s.stacks[e.stack]) {
          s.stacks[e.stack].submitCopied = e.t;
          s.stacks[e.stack].submittedOrder = [...s.stacks[e.stack].order];
          for (const id of s.stacks[e.stack].order) if (s.patches[id]?.revision !== undefined) s.patches[id].sentSha = s.patches[id].sha;
        }
        break;
      case "try-planned": {
        const p = push(e.push);
        p.purpose = e.purpose;
        p.command = e.command;
        p.taskCount = e.taskCount;
        break;
      }
      case "try-declined":
        // Declining one push used to decline the rest of its plan "along with" it, even those you had approved: those
        // still count as approved.
        if (e.text.startsWith("along with ") && !s.needsUser.some((n) => n.key === `approve-push:${e.push}`)) break;
        push(e.push).declined = e.text;
        if (e.replan) push(e.push).replan = true;
        // Those taken down "along with" another were the factory's doing too, and its withdrawals from before "by".
        if (e.by === "factory" || /^(along with |not needed anymore)/.test(e.text)) push(e.push).withdrawn = true;
        s.needsUser = s.needsUser.filter((n) => n.key !== `approve-push:${e.push}`);
        break;
      case "try-pushed": {
        const p = push(e.push);
        p.rev = e.rev;
        p.url = e.url;
        break;
      }
      case "try-progress":
        push(e.push).progress = { done: e.done, total: e.total, failures: e.failures, ...(e.tests ? { tests: e.tests } : {}) };
        break;
      case "try-finished": {
        const p = push(e.push);
        p.result = e.result;
        p.summary = e.summary;
        break;
      }
      case "review-status":
        reviews.set(e.patch, { revision: e.revision, status: e.status, reviewers: e.reviewers, comments: e.comments, ...(e.diff ? { diff: e.diff } : {}), ...(e.author ? { author: e.author } : {}) });
        if (e.diff?.commit && s.patchSent[e.patch]?.at(-1)?.sha !== e.diff.commit) s.patchSent[e.patch] = [...(s.patchSent[e.patch] ?? []), { sha: e.diff.commit, t: e.diff.created }];
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
      case "user-done": {
        // Copying the reorg command: Phabricator gets the stack's order. A reorg flag the factory clears doesn't.
        // Only a copy of the reorg command: other answers to a land ⚑ (the factory's, earlier ones) say nothing of the order.
        const reorg = e.reorg ? /^land:([^:]+):/.exec(e.key)?.[1] : undefined;
        if (reorg && s.stacks[reorg]) s.stacks[reorg].submittedOrder = [...s.stacks[reorg].order];
        s.needsUser = s.needsUser.filter((n) => n.key !== e.key);
        refused = refused.filter((x) => x.key !== e.key);
        break;
      }
      case "command-executed":
        if (e.ok) {
          refused = refused.filter((x) => e.cmd === undefined || x.cmd !== e.cmd || x.item !== e.item || x.job !== e.job);
        } else {
          refused = [...refused, { key: `refused:${e.command}`, command: e.command, cmd: e.cmd, item: e.item, job: e.job, detail: e.detail, t: e.t }].slice(-MAX_REFUSED);
        }
        break;
      case "recovery-plan":
        // Splits planned on 2026-10-28 listed each part's groups, and said why in their reason, a line per group.
        const legacy = (c: { parts: object[]; reason: string }) => {
          const why = new Map(c.reason.split("\n").map((l) => /^(i-[^:\s]+): (.*)$/.exec(l)).filter((m) => m !== null).map((m) => [m[1], m[2]]));
          const parts = (c.parts as { title: string; items: string[] }[]).map((p) => ({ title: p.title, groups: p.items.map((item) => ({ item, why: why.get(item) ?? "" })) }));
          return { cmd: "split-request" as const, parts, reason: "" };
        };
        const plan = e.plan.map((c) => (c.cmd === "split-request" && c.parts.some((p) => "items" in p) ? legacy(c) : c));
        s.recoveryPlans.push({ job: e.job, text: e.text, ...(e.answer ? { answer: e.answer } : {}), plan, cannotDo: e.cannotDo, questions: e.questions, t: e.t });
        break;
      case "note":
        // Review nits and answers to you used to be notes; they are in their job's report.
        if (/^(Review nits|Stack review nits|Its author answered you)\b/.test(e.text)) continue;
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
  s.refused = refused;
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

// What an agent concluded, on one line: its state or verdict, and its summary.
function outcomeOf(report: unknown): string | undefined {
  if (report === null || typeof report !== "object") return undefined;
  const r = report as Record<string, unknown>;
  const head = [r.state, r.status, r.verdict].find((x) => typeof x === "string") as string | undefined;
  const count = (severity: string) => (Array.isArray(r.findings) ? r.findings.filter((f) => (f as { severity?: string }).severity === severity).length : 0);
  const findings = [count("must-fix") && `${count("must-fix")} must-fix`, count("nit") && `${count("nit")} ${count("nit") === 1 ? "nit" : "nits"}`].filter(Boolean).join(", ");
  const text =
    typeof r.disagreement === "string" ? `disagrees with you: ${r.disagreement}` : typeof r.summary === "string" ? r.summary : typeof r.answer === "string" ? r.answer : findings || undefined;
  const out = [head, text].filter(Boolean).join(": ");
  return out ? out.slice(0, 300) : undefined;
}
