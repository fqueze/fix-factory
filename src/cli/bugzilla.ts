// Bugzilla, read-only. Facts only, no verdict.
//
//   node src/cli/bugzilla.ts prior-art <test>
//     → {test, query, bugs: [{id, summary, status, product, component, keywords, assignee, lastChangeTime,
//         revisions: [{revision, obsolete, title?, status?}]}]}
//     Open bugs matching the test's file name (quicksearch). assignee is null for nobody@mozilla.org.
//     revisions are the Phabricator revisions attached to the bug; title and status come from conduit.
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
  firstComment: string; // the first non-empty comment, truncated
}

const FIRST_COMMENT_MAX = 2000;

export async function bugInfo(id: number, fetchFn: typeof fetch = fetch): Promise<BugInfo> {
  const bug = await getJson(`bug/${id}?include_fields=id,summary`, fetchFn);
  const comments = await getJson(`bug/${id}/comment?include_fields=text,count`, fetchFn);
  // Intermittent tracking bugs have an empty comment 0 (the summary says it all).
  const first: string = comments.bugs[String(id)].comments.find((c: { text: string }) => c.text.trim() !== "")?.text ?? "";
  return {
    id,
    summary: bug.bugs[0].summary,
    firstComment: first.length > FIRST_COMMENT_MAX ? first.slice(0, FIRST_COMMENT_MAX) + "…" : first,
  };
}

export interface AttachedRevision {
  revision: number;
  obsolete: boolean;
  title?: string;
  status?: string;
}

export interface PriorArtBug {
  id: number;
  summary: string;
  status: string;
  product: string;
  component: string;
  keywords: string[];
  assignee: string | null;
  lastChangeTime: string;
  revisions: AttachedRevision[];
}

export function priorArtQuery(test: string): string {
  return test.split("/").pop()!;
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
  const fields = "id,summary,status,product,component,keywords,assigned_to,last_change_time";
  // quicksearch only returns open bugs unless the query asks otherwise.
  const found = await getJson(`bug?quicksearch=${encodeURIComponent(query)}&include_fields=${fields}&limit=50`, fetchFn);
  const bugs: PriorArtBug[] = await Promise.all(
    found.bugs.map(async (b: any) => {
      const att = await getJson(`bug/${b.id}/attachment?include_fields=file_name,content_type,is_obsolete`, fetchFn);
      return {
        id: b.id,
        summary: b.summary,
        status: b.status,
        product: b.product,
        component: b.component,
        keywords: b.keywords,
        assignee: b.assigned_to === "nobody@mozilla.org" ? null : b.assigned_to,
        lastChangeTime: b.last_change_time,
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
