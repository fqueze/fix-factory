// Phabricator: read-only, except for the test plan you set.
//
//   node src/cli/phab.ts poll <D-number...>
//     → [{revision, phid, title, status, reviewers: [{name, status}], comments: [{id, author, file, line,
//         length, text, suggestion?, done, replyTo?}]}]
//     status is the revision status value ("needs-review", "accepted", "needs-revision", "published", ...).
//     Reviewer names are usernames, or "#slug" for groups. Reviewer status: accepted | blocking (requested
//     changes, while the revision needs revision) | pending (not acted yet, blocking reviewers included, or
//     requested changes on a diff since updated) | resigned.
//     comments: inline comments, sorted by file and line; id is the one used in D…#inline-<id> links;
//     replyTo is the id of the comment it answers; suggestion is the "suggest edit" replacement text.
//
//   node src/cli/phab.ts reviewers <file...> [--repo <checkout>]   (default: config.firefoxRepo)
//     →{files, suggestions: [{name, source: "mots"|"herald"|"recent", blocking?, modules?, count?}]}
//     from `./mach file-info reviewers --format json`, in the order mach suggests them (mots groups first).
//
//   node src/cli/phab.ts set-test-plan <D-number> --file <text file>
//     → {revision, testPlan}: sets the revision's Test Plan field. The one write: run when you click its button.
//
//   node src/cli/phab.ts check-reviewers <name...>   ("#group" or user name, as in r=)
//     → {unknown: [name...]}: those Phabricator doesn't know, which moz-phab would refuse.
//
// Token: ~/.arcrc. Suggested edits come from transaction.search, which now exposes hasSuggestion and
// suggestionText, so the changeset AJAX scraping of phab-suggestions.py is no longer needed.

import { spawn } from "node:child_process";
import { netLog } from "../lib/netlog.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { runCli, UsageError } from "../lib/cli.ts";
import { execOk } from "../lib/exec.ts";
import { loadConfig } from "../config.ts";
import type { InlineComment, ReviewerStatus } from "../types.ts";

// --repo, or config.firefoxRepo when a factory config exists.
export function repoArg(value: unknown): string | undefined {
  if (typeof value === "string") return resolve(value);
  const path = process.env.FACTORY_CONFIG ?? "factory.config.json";
  return existsSync(path) ? loadConfig(path).firefoxRepo : undefined;
}

export const PHAB = "https://phabricator.services.mozilla.com/";
const API = PHAB + "api/";

export type Conduit = (method: string, params: Record<string, unknown>) => Promise<any>;

export function arcToken(arcrc = join(homedir(), ".arcrc")): string {
  const token = JSON.parse(readFileSync(arcrc, "utf8")).hosts?.[API]?.token;
  if (typeof token !== "string") throw new Error(`no token for ${API} in ${arcrc}`);
  return token;
}

// Phabricator's CDN answers 429 to one kind of client at a time (Node's TLS connection, then curl's), whatever the
// token, and not to the others: a call refused through one goes through the other, which the next calls use. The body
// goes on curl's stdin: the token stays out of the process list.
const curlFetch = ((url: string, init: RequestInit) =>
  new Promise<Response>((resolve, reject) => {
    const curl = spawn("curl", ["-sS", "--data-binary", "@-", "-H", "content-type: application/x-www-form-urlencoded", "-w", "\n%{http_code}", url]);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    curl.stdout.on("data", (c: Buffer) => out.push(c));
    curl.stderr.on("data", (c: Buffer) => err.push(c));
    curl.on("error", reject);
    const start = Date.now();
    const method = `conduit ${url.slice(API.length)}`;
    curl.on("close", (code) => {
      if (code !== 0) {
        const error = `curl: ${Buffer.concat(err).toString().trim() || `exit ${code}`}`;
        netLog({ start, end: Date.now(), method, url, error });
        return reject(new Error(error));
      }
      const text = Buffer.concat(out).toString();
      const nl = text.lastIndexOf("\n");
      const status = Number(text.slice(nl + 1));
      netLog({ start, end: Date.now(), method, url, status, bytes: nl });
      resolve(new Response(text.slice(0, nl), { status }));
    });
    curl.stdin.end(String(init.body));
  })) as typeof fetch;

type Client = "curl" | "node";
const CLIENTS: Record<Client, typeof fetch> = { curl: curlFetch, node: ((url: string, init: RequestInit) => fetch(url, init)) as typeof fetch };

// The client the last refused call switched to, for every job: in the factory's state directory.
function clientFile(): string | undefined {
  const path = process.env.FACTORY_CONFIG ?? "factory.config.json";
  return existsSync(path) ? join(loadConfig(path).stateDir, "phab-client") : undefined;
}

export function switchingFetch(clients: Record<Client, typeof fetch> = CLIENTS, file: string | undefined = clientFile()): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const first: Client = file && existsSync(file) && readFileSync(file, "utf8").trim() === "node" ? "node" : "curl";
    const res = await clients[first](url, init);
    if (res.status !== 429) return res;
    const other: Client = first === "curl" ? "node" : "curl";
    const again = await clients[other](url, init);
    if (again.status !== 429 && file) writeFileSync(file, other + "\n");
    return again;
  }) as typeof fetch;
}

export function makeConduit(fetchFn: typeof fetch = switchingFetch(), getToken: () => string = () => arcToken()): Conduit {
  let token: string | undefined;
  return async (method, params) => {
    token ??= getToken();
    const body = new URLSearchParams({ params: JSON.stringify({ ...params, __conduit__: { token } }), output: "json" });
    const res = await fetchFn(API + method, { method: "POST", body });
    if (!res.ok) {
      throw new Error(`${method}: HTTP ${res.status}`);
    }
    const json = (await res.json()) as { result: unknown; error_code: string | null; error_info: string | null };
    if (json.error_code) {
      throw new Error(`${method}: ${json.error_code}: ${json.error_info}`);
    }
    return json.result;
  };
}

// Follows the cursor of a *.search method.
async function searchAll(conduit: Conduit, method: string, params: Record<string, unknown>): Promise<any[]> {
  const out: any[] = [];
  let after: string | null = null;
  do {
    const r: any = await conduit(method, after ? { ...params, after } : params);
    out.push(...r.data);
    after = r.cursor?.after ?? null;
  } while (after);
  return out;
}

// Conduit keeps reporting "accepted" and "rejected" after the author updates the diff: prior says the reviewer acted
// on an older one, as Phabricator shows it ("requested changes on prior diff").
export function reviewerStatus(phabStatus: string, prior = false): ReviewerStatus["status"] {
  switch (phabStatus) {
    case "accepted":
      return prior ? "accepted-prior" : "accepted";
    case "rejected":
      return prior ? "rejected-prior" : "blocking";
    case "resigned":
      return "resigned";
    case "blocking":
      // A blocking reviewer who hasn't acted yet: the revision can't be accepted without them.
      return "required";
    default:
      // "added".
      return "pending";
  }
}

// The UI inserts a badge such as "{nav, icon=check, name=Done}" at the start of some comments.
export function stripBadge(prose: string): string {
  return prose.replace(/^\{nav,?\s*icon=[\w-]+,\s*name=([^}]*)\}\s*/, "$1 ").trim();
}

export interface PolledComment extends InlineComment {
  length: number;
  replyTo?: number;
}

export interface PollResult {
  revision: number;
  phid: string;
  title: string;
  author?: string; // who submitted it: your own comments aren't review comments
  status: string;
  reviewers: ReviewerStatus[];
  comments: PolledComment[];
  diff?: { id: number; commit?: string; created: string }; // its latest diff, and the local commit moz-phab sent it from
  reopenedAt?: string; // its latest reopen after a close (a backout), even one no poll saw it closed before
  parent?: number; // the revision under it in its stack on Phabricator (how Phabricator lists the stack)
  modified?: number; // Phabricator's dateModified: unchanged since a poll, that poll's result stands
}

async function names(conduit: Conduit, phids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const users = phids.filter((p) => p.startsWith("PHID-USER-"));
  const projects = phids.filter((p) => p.startsWith("PHID-PROJ-"));
  if (users.length) {
    for (const u of await searchAll(conduit, "user.search", { constraints: { phids: users } })) {
      map.set(u.phid, u.fields.username);
    }
  }
  if (projects.length) {
    for (const p of await searchAll(conduit, "project.search", { constraints: { phids: projects } })) {
      map.set(p.phid, "#" + (p.fields.slug ?? p.fields.name));
    }
  }
  return map;
}

// The names of an r= that Phabricator doesn't know, as written: "#group" is a project slug, the rest user names; a
// blocking "!" doesn't count.
export async function unknownReviewers(names: string[], conduit: Conduit = makeConduit()): Promise<string[]> {
  const bare = (n: string) => n.replace(/!$/, "").toLowerCase();
  const users = names.map(bare).filter((n) => !n.startsWith("#"));
  const groups = names.map(bare).filter((n) => n.startsWith("#")).map((n) => n.slice(1));
  const known = new Set<string>();
  if (users.length) for (const u of await searchAll(conduit, "user.search", { constraints: { usernames: users } })) known.add(u.fields.username.toLowerCase());
  if (groups.length) for (const p of await searchAll(conduit, "project.search", { constraints: { slugs: groups } })) known.add(`#${p.fields.slug.toLowerCase()}`);
  return names.filter((n) => !known.has(bare(n)));
}

// The revision's Test Plan field, which Phabricator shows when it isn't empty. Its firewall refuses (HTTP 406) any
// request with <script>, <iframe> or <link …> in it, escaped or not: a zero-width space after each "<" before a
// letter gets the text through, shown the same.
export async function setTestPlan(revision: number, text: string, conduit: Conduit = makeConduit()): Promise<{ revision: number; testPlan: string }> {
  const value = text.replace(/<(?=[A-Za-z])/g, "<\u200b");
  await conduit("differential.revision.edit", { objectIdentifier: `D${revision}`, transactions: [{ type: "testPlan", value }] });
  return { revision, testPlan: text };
}

// previous: an earlier poll's results. A revision Phabricator hasn't modified since keeps its result there, without
// the calls reading its transactions, diffs and stack: when none changed, a poll is one call.
export async function poll(revisions: number[], conduit: Conduit = makeConduit(), previous: PollResult[] = []): Promise<PollResult[]> {
  const all = await searchAll(conduit, "differential.revision.search", {
    constraints: { ids: revisions },
    attachments: { reviewers: true },
  });
  const missing = revisions.filter((id) => !all.some((r) => r.id === id));
  if (missing.length) {
    throw new Error(`not found: ${missing.map((id) => "D" + id).join(", ")}`);
  }
  const kept = new Map(previous.filter((p) => p.modified !== undefined && all.some((r) => r.id === p.revision && r.fields.dateModified === p.modified)).map((p) => [p.revision, p]));
  const changed = revisions.filter((id) => !kept.has(id));
  if (changed.length === 0) return revisions.map((id) => kept.get(id)!);
  const fresh = await pollChanged(changed, all.filter((r) => changed.includes(r.id)), all, conduit);
  return revisions.map((id) => kept.get(id) ?? fresh.find((x) => x.revision === id)!);
}

async function pollChanged(revisions: number[], revs: any[], all: any[], conduit: Conduit): Promise<PollResult[]> {
  const byId = new Map(revs.map((r) => [r.id as number, r]));

  // Its place in its stack, as Phabricator has it.
  const parentOf = new Map<string, string>();
  for (const e of await searchAll(conduit, "edge.search", { sourcePHIDs: revs.map((r) => r.phid), types: ["revision.parent"] })) parentOf.set(e.sourcePHID, e.destinationPHID);
  const idOfRev = new Map<string, number>(all.map((r) => [r.phid as string, r.id as number]));

  const txnsByRev = new Map<number, any[]>();
  for (const id of revisions) {
    txnsByRev.set(id, await searchAll(conduit, "transaction.search", { objectIdentifier: byId.get(id).phid }));
  }

  const phids = new Set<string>();
  for (const r of revs) {
    for (const rv of r.attachments.reviewers.reviewers) phids.add(rv.reviewerPHID);
    phids.add(r.fields.authorPHID);
  }
  for (const txns of txnsByRev.values()) {
    for (const t of txns) if (t.type === "inline" || t.type === "comment") for (const c of t.comments) phids.add(c.authorPHID);
  }
  const nameOf = await names(conduit, [...phids].sort());
  // Newest first: the first diff seen for a revision is its latest.
  const diffs = await searchAll(conduit, "differential.diff.search", { constraints: { revisionPHIDs: revs.map((r) => r.phid) }, attachments: { commits: true }, order: "newest" });
  const latest = new Map<string, any>();
  for (const d of diffs) if (!latest.has(d.fields.revisionPHID)) latest.set(d.fields.revisionPHID, d);

  return revisions.map((id) => {
    const r = byId.get(id);
    const inlines = (txnsByRev.get(id) ?? []).filter((t) => t.type === "inline");
    const idOfPhid = new Map<string, number>();
    for (const t of inlines) for (const c of t.comments) idOfPhid.set(c.phid, c.id);
    const comments: PolledComment[] = [];
    for (const t of inlines) {
      for (const c of t.comments) {
        if (c.removed) continue;
        const f = t.fields;
        const comment: PolledComment = {
          id: c.id,
          author: nameOf.get(c.authorPHID) ?? c.authorPHID,
          file: f.path,
          line: f.line,
          length: f.length,
          text: stripBadge(c.content.raw),
          done: Boolean(f.isDone),
        };
        // suggestionText alone is not a signal: it is pre-filled with the original line.
        if (f.hasSuggestion) comment.suggestion = f.suggestionText;
        if (f.replyToCommentPHID) comment.replyTo = idOfPhid.get(f.replyToCommentPHID);
        comments.push(comment);
      }
    }
    // General comments on the revision, not on a line: nothing marks them done, so one older than the latest diff
    // counts as answered by it.
    const diffAt = latest.get(r.phid)?.fields.dateCreated ?? 0;
    for (const t of (txnsByRev.get(id) ?? []).filter((t) => t.type === "comment")) {
      for (const c of t.comments) {
        if (c.removed) continue;
        comments.push({ id: c.id, author: nameOf.get(c.authorPHID) ?? c.authorPHID, length: 0, text: stripBadge(c.content.raw), done: c.dateCreated < diffAt });
      }
    }
    comments.sort((a, b) => (a.file ?? "").localeCompare(b.file ?? "") || (a.line ?? 0) - (b.line ?? 0) || a.id - b.id);
    // Landed then backed out while nobody polled: Phabricator still has the close and the reopen.
    const latestOf = (type: string) => Math.max(0, ...(txnsByRev.get(id) ?? []).filter((t) => t.type === type).map((t) => t.dateCreated as number));
    const closed = latestOf("close");
    const reopened = latestOf("reopen");
    return {
      revision: id,
      phid: r.phid,
      title: r.fields.title,
      author: nameOf.get(r.fields.authorPHID) ?? r.fields.authorPHID,
      status: r.fields.status.value,
      reviewers: r.attachments.reviewers.reviewers.map((rv: any) => {
        // On a prior diff: a person's latest accept or request for changes is older than the latest diff; a group's,
        // when nobody acted that way since (Conduit doesn't say which members act for it).
        const type = rv.status === "accepted" ? "accept" : "request-changes";
        const acts = (txnsByRev.get(id) ?? []).filter((t) => t.type === type && (!String(rv.reviewerPHID).startsWith("PHID-USER-") || t.authorPHID === rv.reviewerPHID));
        // Diffs its author uploaded: landing adds one too, which doesn't make the accepts prior.
        const updated = Math.max(0, ...(txnsByRev.get(id) ?? []).filter((t) => t.type === "update" && t.authorPHID === r.fields.authorPHID).map((t) => t.dateCreated as number));
        const prior = (rv.status === "accepted" || rv.status === "rejected") && updated > 0 && !acts.some((t) => t.dateCreated > updated);
        return { name: nameOf.get(rv.reviewerPHID) ?? rv.reviewerPHID, status: reviewerStatus(rv.status, prior) };
      }),
      comments,
      ...(latest.has(r.phid)
        ? {
            diff: {
              id: latest.get(r.phid).id,
              ...(latest.get(r.phid).attachments.commits.commits[0]?.identifier ? { commit: latest.get(r.phid).attachments.commits.commits[0].identifier } : {}),
              created: new Date(latest.get(r.phid).fields.dateCreated * 1000).toISOString(),
            },
          }
        : {}),
      ...(closed && reopened > closed ? { reopenedAt: new Date(reopened * 1000).toISOString() } : {}),
      ...(idOfRev.has(parentOf.get(r.phid) ?? "") ? { parent: idOfRev.get(parentOf.get(r.phid)!) } : {}),
      modified: r.fields.dateModified,
    };
  });
}

export function parseRevision(arg: string): number {
  const m = /^(?:.*\/)?D?(\d+)$/i.exec(arg.trim());
  if (!m) throw new Error(`not a revision: ${arg}`);
  return Number(m[1]);
}

export interface ReviewerSuggestion {
  name: string; // "#places-reviewers" or "mconley"
  source: "mots" | "herald" | "recent";
  blocking?: boolean;
  modules?: string[];
  count?: number;
}

interface FileInfoReviewers {
  files: string[];
  mots_groups?: { name: string; modules: string[] }[];
  herald_groups?: { name: string; blocking: boolean }[];
  herald_individuals?: { name: string; blocking: boolean }[];
  recent_groups?: { name: string; count: number }[];
  recent_individuals?: { name: string; count: number }[];
}

export function parseFileInfoReviewers(json: string): { files: string[]; suggestions: ReviewerSuggestion[] } {
  const d = JSON.parse(json) as FileInfoReviewers;
  const group = (n: string) => (n.startsWith("#") ? n : "#" + n);
  const suggestions: ReviewerSuggestion[] = [
    ...(d.mots_groups ?? []).map((g) => ({ name: group(g.name), source: "mots" as const, modules: g.modules })),
    ...(d.herald_groups ?? []).map((g) => ({ name: group(g.name), source: "herald" as const, blocking: g.blocking })),
    ...(d.herald_individuals ?? []).map((g) => ({ name: g.name, source: "herald" as const, blocking: g.blocking })),
    ...(d.recent_groups ?? []).map((g) => ({ name: group(g.name), source: "recent" as const, count: g.count })),
    ...(d.recent_individuals ?? []).map((g) => ({ name: g.name, source: "recent" as const, count: g.count })),
  ];
  return { files: d.files, suggestions };
}

export function reviewersCommand(files: string[]): string[] {
  return ["./mach", "file-info", "reviewers", "--format", "json", ...files];
}

export async function reviewers(files: string[], repo: string) {
  return parseFileInfoReviewers(await execOk(reviewersCommand(files), { cwd: repo }));
}

async function main() {
  await runCli(
    {
      poll: async (args, values) => {
        if (!args.length) throw new UsageError("usage: poll <D-number...>");
        let revisions: number[];
        try {
          revisions = args.map(parseRevision);
        } catch (e) {
          throw new UsageError((e as Error).message);
        }
        const previous = typeof values.previous === "string" && existsSync(values.previous) ? (JSON.parse(readFileSync(values.previous, "utf8")) as PollResult[]) : [];
        return poll(revisions, makeConduit(), previous);
      },
      "set-test-plan": async (args, values) => {
        if (args.length !== 1 || typeof values.file !== "string") throw new UsageError("usage: set-test-plan <D-number> --file <text file>");
        const text = readFileSync(values.file, "utf8").trim();
        if (values["dry-run"]) return { revision: parseRevision(args[0]), testPlan: text, dryRun: true };
        return setTestPlan(parseRevision(args[0]), text);
      },
      "check-reviewers": async (args) => {
        if (!args.length) throw new UsageError("usage: check-reviewers <name...>");
        return { unknown: await unknownReviewers(args) };
      },
      reviewers: async (args, values) => {
        const repo = repoArg(values.repo);
        if (!args.length || !repo) throw new UsageError("usage: reviewers <file...> [--repo <checkout>]");
        return reviewers(args, repo);
      },
    },
    { repo: { type: "string" }, file: { type: "string" }, previous: { type: "string" } },
  );
}

if (import.meta.main) {
  await main();
}
