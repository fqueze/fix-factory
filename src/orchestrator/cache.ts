// The artifact cache (cache/artifacts/<task>/: the logs and profiles of try jobs that failed, ~100 MB a task): a
// task's folder goes once every request that fetched it is over, a day after it finished or split, or 28 days after
// its last event; a folder no request fetched (one made by hand), 28 days after it was made.
import type { RequestState } from "../types.ts";

const HOUR = 3_600_000;
export const CACHE_AFTER_DONE_MS = 24 * HOUR;
export const CACHE_INACTIVE_MS = 28 * 24 * HOUR;

// Whether a request no longer needs the logs it fetched.
export function cacheExpired(s: Pick<RequestState, "step" | "updatedAt" | "finishedAt" | "splitInto">, now: number): boolean {
  if (now - Date.parse(s.updatedAt) > CACHE_INACTIVE_MS) return true;
  // finishedAt stays when a request goes back from done (a backout).
  const over = s.step === "done" ? s.finishedAt : s.splitInto ? s.updatedAt : undefined;
  return over !== undefined && now - Date.parse(over) > CACHE_AFTER_DONE_MS;
}

// The tasks fetched by its artifacts jobs (purpose key artifacts:<task>:<run>).
export function fetchedTasks(s: Pick<RequestState, "jobs">): string[] {
  return Object.values(s.jobs).flatMap((j) => (j.purpose?.what === "artifacts" ? [j.purpose.key.split(":")[1]] : []));
}

// The cached tasks to remove: present lists the folders there, with when each was made.
export function expiredTasks(requests: Pick<RequestState, "jobs" | "step" | "updatedAt" | "finishedAt" | "splitInto">[], present: { task: string; madeAt: number }[], now: number): string[] {
  const keep = new Set<string>();
  const fetched = new Set<string>();
  for (const s of requests) {
    const expired = cacheExpired(s, now);
    for (const t of fetchedTasks(s)) {
      fetched.add(t);
      if (!expired) keep.add(t);
    }
  }
  return present.filter((p) => !keep.has(p.task) && (fetched.has(p.task) || now - p.madeAt > CACHE_INACTIVE_MS)).map((p) => p.task);
}
