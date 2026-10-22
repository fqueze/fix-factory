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

import { existsSync, readFileSync } from "node:fs";
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

export function makeConduit(fetchFn: typeof fetch = fetch, getToken: () => string = () => arcToken()): Conduit {
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

// Conduit keeps reporting "rejected" after the author updates the diff and the revision goes back to
// needs-review, so it only blocks while the revision still needs revision.
export function reviewerStatus(phabStatus: string, revisionStatus: string): ReviewerStatus["status"] {
  switch (phabStatus) {
    case "accepted":
      return "accepted";
    case "rejected":
      return revisionStatus === "needs-revision" ? "blocking" : "pending";
    case "resigned":
      return "resigned";
    default:
      // "added", and "blocking" (a blocking reviewer who hasn't acted yet).
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
  status: string;
  reviewers: ReviewerStatus[];
  comments: PolledComment[];
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

// The revision's Test Plan field, which Phabricator shows when it isn't empty.
export async function setTestPlan(revision: number, text: string, conduit: Conduit = makeConduit()): Promise<{ revision: number; testPlan: string }> {
  await conduit("differential.revision.edit", { objectIdentifier: `D${revision}`, transactions: [{ type: "testPlan", value: text }] });
  return { revision, testPlan: text };
}

export async function poll(revisions: number[], conduit: Conduit = makeConduit()): Promise<PollResult[]> {
  const revs = await searchAll(conduit, "differential.revision.search", {
    constraints: { ids: revisions },
    attachments: { reviewers: true },
  });
  const byId = new Map(revs.map((r) => [r.id as number, r]));
  const missing = revisions.filter((id) => !byId.has(id));
  if (missing.length) {
    throw new Error(`not found: ${missing.map((id) => "D" + id).join(", ")}`);
  }

  const txnsByRev = new Map<number, any[]>();
  for (const id of revisions) {
    txnsByRev.set(id, await searchAll(conduit, "transaction.search", { objectIdentifier: byId.get(id).phid }));
  }

  const phids = new Set<string>();
  for (const r of revs) {
    for (const rv of r.attachments.reviewers.reviewers) phids.add(rv.reviewerPHID);
  }
  for (const txns of txnsByRev.values()) {
    for (const t of txns) if (t.type === "inline") for (const c of t.comments) phids.add(c.authorPHID);
  }
  const nameOf = await names(conduit, [...phids].sort());

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
    comments.sort((a, b) => (a.file ?? "").localeCompare(b.file ?? "") || (a.line ?? 0) - (b.line ?? 0) || a.id - b.id);
    return {
      revision: id,
      phid: r.phid,
      title: r.fields.title,
      status: r.fields.status.value,
      reviewers: r.attachments.reviewers.reviewers.map((rv: any) => ({
        name: nameOf.get(rv.reviewerPHID) ?? rv.reviewerPHID,
        status: reviewerStatus(rv.status, r.fields.status.value),
      })),
      comments,
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
      poll: async (args) => {
        if (!args.length) throw new UsageError("usage: poll <D-number...>");
        let revisions: number[];
        try {
          revisions = args.map(parseRevision);
        } catch (e) {
          throw new UsageError((e as Error).message);
        }
        return poll(revisions);
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
    { repo: { type: "string" }, file: { type: "string" } },
  );
}

if (import.meta.main) {
  await main();
}
