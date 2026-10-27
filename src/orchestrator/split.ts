// Splitting a request into new ones, each taking some of its groups with their history: the events about those
// groups (their jobs and sessions, patches, bugs, test plans, flags) and the try pushes made, which stay evidence
// for every part. The stack, its meta bug and its planned pushes aren't copied: each new request makes its own,
// its planner judging from the pushes made what still needs one. Pure.
import type { EventInput } from "../state/events.ts";
import type { Event, ItemId, JobId, PatchId, RequestId, RequestState } from "../types.ts";

export interface SplitPart {
  title: string;
  items: ItemId[];
}

// Why a split can't be done as asked, or undefined.
export function splitProblem(s: RequestState, parts: SplitPart[]): string | undefined {
  if (parts.length < 2) return "a split needs two parts or more";
  const all = parts.flatMap((p) => p.items);
  const unknown = all.find((i) => !s.items[i]);
  if (unknown) return `unknown group ${unknown}`;
  const twice = all.find((i, n) => all.indexOf(i) !== n);
  if (twice) return `${twice} is in two parts`;
  const empty = parts.find((p) => p.items.length === 0);
  if (empty) return `“${empty.title}” has no groups`;
  const running = Object.values(s.jobs).find((j) => j.endedAt === undefined);
  if (running) return `${running.name} is running: split once it's done`;
  const submitted = Object.values(s.patches).find((p) => p.revision !== undefined && all.includes(p.item ?? ""));
  if (submitted) return `${submitted.title} is on Phabricator already: splitting a submitted stack isn't supported`;
  // Each part's patches are assembled on their own: one needing another part's can't be.
  const partOf = new Map(parts.flatMap((p, n) => p.items.map((i) => [i, n] as const)));
  for (const p of Object.values(s.patches)) {
    for (const d of p.deps.filter((d) => d.kind === "hard")) {
      const needed = s.patches[d.needs];
      if (!needed || p.item === undefined || needed.item === undefined || !partOf.has(p.item) || !partOf.has(needed.item)) continue;
      if (partOf.get(p.item) !== partOf.get(needed.item)) return `${p.title} needs ${needed.title} (${d.reason}): put them in the same part`;
    }
  }
  return undefined;
}

// The original's events a new request taking these groups starts from, addressed to it.
export function partEvents(events: Event[], s: RequestState, items: ItemId[], to: RequestId): EventInput[] {
  const own = new Set(items);
  const patchesOwn = new Set<PatchId>(Object.values(s.patches).filter((p) => p.item !== undefined && own.has(p.item)).map((p) => p.id));
  const made = new Set(Object.values(s.pushes).filter((p) => p.rev).map((p) => p.id));
  const finished = new Set(events.filter((e) => e.type === "job-finished").map((e) => e.job));
  // Its groups' finished jobs, and those of the pushes made (dry-run, push, watch, triage).
  const jobs = new Set<JobId>();
  for (const e of events) {
    if (e.type !== "job-started" || !finished.has(e.job)) continue;
    const item = e.item ?? e.purpose?.item;
    if (item !== undefined ? own.has(item) : (e.purpose?.push !== undefined && made.has(e.purpose.push)) || (e.purpose?.patch !== undefined && patchesOwn.has(e.purpose.patch))) jobs.add(e.job);
  }
  const flags = new Set<string>();
  const keep = (e: Event): boolean => {
    switch (e.type) {
      case "item-created":
      case "item-state":
      case "item-group":
        return own.has(e.item);
      case "job-started":
      case "job-finished":
      case "agent-report":
        return jobs.has(e.job);
      case "patch":
      case "test-plan":
      case "test-plan-sent":
      case "review-status":
      case "reply-draft":
        return patchesOwn.has(e.patch);
      case "dep":
        return patchesOwn.has(e.dep.patch);
      case "dep-removed":
        return patchesOwn.has(e.patch);
      case "try-planned":
      case "try-context":
      case "try-declined":
      case "try-pushed":
      case "try-progress":
      case "try-job-failed":
      case "try-finished":
        return made.has(e.push);
      case "hand-off":
        return e.items.every((i) => own.has(i));
      case "needs-user": {
        // Its groups' own questions; those about the stack, its pushes and its meta bug belong to the original's.
        const ok = e.push === undefined && e.stack === undefined && ((e.item !== undefined && own.has(e.item)) || (e.job !== undefined && jobs.has(e.job)) || (e.patch !== undefined && patchesOwn.has(e.patch)));
        if (ok) flags.add(e.key);
        return ok;
      }
      case "user-done":
        return flags.has(e.key) || (e.key.startsWith("reopen:") && jobs.has(e.key.slice("reopen:".length)));
      default:
        return false;
    }
  };
  return events.filter(keep).map(({ request: _r, ...e }) => ({ ...e, request: to }) as EventInput);
}
