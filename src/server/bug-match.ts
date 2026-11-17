// The bugs you filed from the factory's "Bug to file" links, found when you come back to its page (src/server/bug-watch.js
// records each link you followed): one Bugzilla search, then each new bug matched to the draft it was filed from.
import { getJson } from "../cli/bugzilla.ts";
import type { RequestState } from "../types.ts";

// A "Bug to file" link you followed, as the page kept it.
export interface PendingDraft {
  key: string; // "<request>\n<patch>", the patch "meta" for the meta bug
  request: string;
  patch: string;
  summary: string; // the draft's, as the link filed it
  title: string; // what the notice names
  t: string; // when you followed it
}

export interface FiledBug {
  id: number;
  summary: string;
  creation_time: string;
}

export interface BugMatch {
  key: string;
  request: string;
  patch: string;
  title: string;
  bug: number;
}

// A link followed this long ago no longer waits for its bug.
export const PENDING_MS = 3 * 3600_000;
// Bugzilla's clock against the browser's: a bug may say it was created a little before the click that filed it.
const SKEW_MS = 5 * 60_000;

// What's settled already: a patch with a bug (set some other way), a request or patch gone, a link too old.
export function settledKeys(pending: PendingDraft[], getRequest: (id: string) => RequestState | undefined, now: number): string[] {
  return pending
    .filter((p) => {
      const r = getRequest(p.request);
      if (!r || now - Date.parse(p.t) > PENDING_MS) return true;
      if (p.patch === "meta") return !!r.metaBug?.bug;
      const patch = r.patches[p.patch];
      return !patch || (patch.bug !== null && patch.bug !== 0);
    })
    .map((p) => p.key);
}

// A bug whose summary is a draft's goes to it; else one draft waiting and one new bug go together; else nothing (you
// type it). Bugs a patch (or the meta bug) of the draft's request has already are never new.
export function matchFiledBugs(pending: PendingDraft[], bugs: FiledBug[], getRequest: (id: string) => RequestState | undefined): BugMatch[] {
  const known = (request: string) => {
    const r = getRequest(request);
    return new Set([...Object.values(r?.patches ?? {}).map((p) => p.bug), r?.metaBug?.bug].filter((b): b is number => !!b));
  };
  const fresh = (p: PendingDraft) => bugs.filter((b) => !known(p.request).has(b.id) && Date.parse(b.creation_time) >= Date.parse(p.t) - SKEW_MS);
  const same = (a: string, b: string) => a.trim().replace(/\s+/g, " ") === b.trim().replace(/\s+/g, " ");
  const claimed = new Set<number>();
  const matches: BugMatch[] = [];
  for (const p of pending) {
    const bySummary = fresh(p).filter((b) => same(b.summary, p.summary) && !claimed.has(b.id));
    if (bySummary.length !== 1) continue;
    claimed.add(bySummary[0].id);
    matches.push({ key: p.key, request: p.request, patch: p.patch, title: p.title, bug: bySummary[0].id });
  }
  if (pending.length === 1 && matches.length === 0) {
    const left = fresh(pending[0]).filter((b) => !claimed.has(b.id));
    if (left.length === 1) matches.push({ key: pending[0].key, request: pending[0].request, patch: pending[0].patch, title: pending[0].title, bug: left[0].id });
  }
  return matches;
}

// The bugs assigned to you (the bugs to file are, see enterBugUrl) created since then: one read-only search, no API key.
export async function filedBugs(email: string, since: string, fetchFn: typeof fetch = fetch): Promise<FiledBug[]> {
  const q = new URLSearchParams({ assigned_to: email, creation_time: since, include_fields: "id,summary,creation_time" });
  const json = await getJson(`bug?${q}`, fetchFn);
  return json.bugs as FiledBug[];
}
