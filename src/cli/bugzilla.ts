// Bugzilla, read-only. Facts only, no verdict.
//
//   node src/cli/bugzilla.ts prior-art <test>
//     → {test, query, bugs: [{id, summary, status, product, component, keywords, assignee, lastHumanComment,
//         revisions: [{revision, obsolete, title?, status?, modified?}]}]}
//     Open bugs matching the test's file name (quicksearch). assignee is null for nobody@mozilla.org.
//     lastHumanComment is the latest comment not written by a bot ({time, author} or null): Bugzilla's
//     last_change_time counts the intermittent-failure bot, so it says nothing about anyone working on it.
//     revisions are the Phabricator revisions attached to the bug; title, status and modified come from conduit.
//
//   node src/cli/bugzilla.ts enter-url <draft.json>
//     → {url}: a prefilled enter_bug.cgi URL for a BugDraft, with the field names of the bug-filing
//     skill's file-bug.py (product, component, short_desc, comment, blocked, bug_type, keywords).

import { readFileSync } from "node:fs";
import { runCli, UsageError } from "../lib/cli.ts";
import type { BugDraft } from "../types.ts";
import { makeConduit, type Conduit } from "./phab.ts";

export const BUGZILLA = "https://bugzilla.mozilla.org/";
const REST = BUGZILLA + "rest/";

export async function getJson(path: string, fetchFn: typeof fetch = fetch): Promise<any> {
  const res = await fetchFn(REST + path);
  const json = (await res.json()) as any;
  if (!res.ok || json.error) {
    throw new Error(`Bugzilla ${path}: ${json.message ?? `HTTP ${res.status}`}`);
  }
  return json;
}

export interface BugInfo {
  id: number;
  summary: string;
  status: string;
  resolution: string;
  firstComment: string; // the first non-empty comment, truncated
}

const FIRST_COMMENT_MAX = 2000;

export async function bugInfo(id: number, fetchFn: typeof fetch = fetch): Promise<BugInfo> {
  const bug = await getJson(`bug/${id}?include_fields=id,summary,status,resolution`, fetchFn);
  const comments = await getJson(`bug/${id}/comment?include_fields=text,count`, fetchFn);
  // Intermittent tracking bugs have an empty comment 0 (the summary says it all).
  const first: string = comments.bugs[String(id)].comments.find((c: { text: string }) => c.text.trim() !== "")?.text ?? "";
  return {
    id,
    summary: bug.bugs[0].summary,
    status: bug.bugs[0].status,
    resolution: bug.bugs[0].resolution,
    firstComment: first.length > FIRST_COMMENT_MAX ? first.slice(0, FIRST_COMMENT_MAX) + "…" : first,
  };
}

export interface AttachedRevision {
  revision: number;
  obsolete: boolean;
  title?: string;
  status?: string;
  modified?: string; // last update of the revision on Phabricator
}

export interface PriorArtBug {
  id: number;
  summary: string;
  status: string;
  product: string;
  component: string;
  keywords: string[];
  assignee: string | null;
  lastHumanComment: { time: string; author: string } | null;
  revisions: AttachedRevision[];
}

const REVISION_STATUS: Record<string, string> = { published: "landed", "needs-review": "in review", "needs-revision": "needs revision", "changes-planned": "changes planned" };

// One line for the page: who is on the bug, and its revisions.
export function describePriorArt(b: PriorArtBug): string {
  const day = (t: string) => t.slice(0, 10);
  const who = [b.status, b.assignee && `assigned to ${b.assignee}`, b.lastHumanComment && `last comment by ${b.lastHumanComment.author} on ${day(b.lastHumanComment.time)}`].filter(Boolean).join(", ");
  const revs = b.revisions
    .filter((r) => !r.obsolete)
    .map((r) => `D${r.revision} ${REVISION_STATUS[r.status ?? ""] ?? r.status ?? ""}${r.modified ? `, updated ${day(r.modified)}` : ""}`);
  return `Bug ${b.id} - ${b.summary} (${who})${revs.length ? `: ${revs.join("; ")}` : ""}.`;
}

export function priorArtQuery(test: string): string {
  return test.split("/").pop()!;
}

// Bugzilla bot accounts: intermittent-bug-filer@mozilla.bugs, release-mgmt-account-bot@mozilla.tld,
// update-bot@bmo.tld, orangefactor@bots.tld...
export function isBot(email: string): boolean {
  return /@(mozilla\.bugs|[\w.-]+\.tld)$/i.test(email);
}

export function lastHumanComment(comments: { creator: string; creation_time: string }[]): { time: string; author: string } | null {
  const human = comments.filter((c) => !isBot(c.creator)).at(-1);
  return human ? { time: human.creation_time, author: human.creator } : null;
}

export function revisionsFromAttachments(attachments: { content_type: string; file_name: string; is_obsolete: number }[]): AttachedRevision[] {
  const out: AttachedRevision[] = [];
  for (const a of attachments) {
    const m = /^phabricator-D(\d+)-url\.txt$/.exec(a.file_name);
    if (a.content_type === "text/x-phabricator-request" && m) {
      out.push({ revision: Number(m[1]), obsolete: Boolean(a.is_obsolete) });
    }
  }
  return out;
}

export async function priorArt(test: string, fetchFn: typeof fetch = fetch, conduit: Conduit = makeConduit()) {
  const query = priorArtQuery(test);
  const fields = "id,summary,status,product,component,keywords,assigned_to";
  // quicksearch only returns open bugs unless the query asks otherwise.
  const found = await getJson(`bug?quicksearch=${encodeURIComponent(query)}&include_fields=${fields}&limit=50`, fetchFn);
  const bugs: PriorArtBug[] = await Promise.all(
    found.bugs.map(async (b: any) => {
      const [att, comments] = await Promise.all([
        getJson(`bug/${b.id}/attachment?include_fields=file_name,content_type,is_obsolete`, fetchFn),
        getJson(`bug/${b.id}/comment?include_fields=creator,creation_time`, fetchFn),
      ]);
      return {
        id: b.id,
        summary: b.summary,
        status: b.status,
        product: b.product,
        component: b.component,
        keywords: b.keywords,
        assignee: b.assigned_to === "nobody@mozilla.org" ? null : b.assigned_to,
        lastHumanComment: lastHumanComment(comments.bugs[String(b.id)].comments),
        revisions: revisionsFromAttachments(att.bugs[String(b.id)] ?? []),
      };
    }),
  );
  const ids = [...new Set(bugs.flatMap((b) => b.revisions.map((r) => r.revision)))].sort((a, b) => a - b);
  if (ids.length) {
    const revs = await conduit("differential.revision.search", { constraints: { ids }, limit: 100 });
    const byId = new Map<number, any>(revs.data.map((r: any) => [r.id, r]));
    for (const r of bugs.flatMap((b) => b.revisions)) {
      const rev = byId.get(r.revision);
      if (rev) {
        r.title = rev.fields.title;
        r.status = rev.fields.status.value;
        r.modified = new Date(rev.fields.dateModified * 1000).toISOString();
      }
    }
  }
  return { test, query, bugs };
}

// Python's urllib.parse.quote(safe=""), which file-bug.py uses: encodeURIComponent leaves !'()* alone.
function quote(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

export function enterBugUrl(draft: BugDraft): string {
  const fields: [string, string][] = [
    ["product", draft.product],
    ["component", draft.component],
    ["short_desc", draft.summary],
    ["comment", draft.description],
    ...(draft.blocks ?? []).map((b): [string, string] => ["blocked", String(b)]),
    ...(draft.dependsOn ?? []).map((b): [string, string] => ["dependson", String(b)]),
  ];
  if (draft.bugType) fields.push(["bug_type", draft.bugType]);
  if (draft.keywords?.length) fields.push(["keywords", draft.keywords.join(", ")]);
  return BUGZILLA + "enter_bug.cgi?" + fields.map(([k, v]) => `${k}=${quote(v)}`).join("&");
}

async function main() {
  await runCli({
    "prior-art": async (args) => {
      if (args.length !== 1) throw new UsageError("usage: prior-art <test>");
      return priorArt(args[0]);
    },
    "enter-url": async (args) => {
      if (args.length !== 1) throw new UsageError("usage: enter-url <draft.json>");
      return { url: enterBugUrl(JSON.parse(readFileSync(args[0], "utf8")) as BugDraft) };
    },
  });
}

if (import.meta.main) {
  await main();
}
