// Skip and failure annotations of a folder's test manifests.
//
//   node src/cli/annotations.ts list <folder> [--repo <firefox checkout>]   (default: config.firefoxRepo)
//     → [{manifest, test, kind, condition, comment?, line, commit, bug, commentBugs}]
//     manifest: path relative to the repo. test: the manifest section; "DEFAULT" applies to every test of the
//     manifest. kind: "skip-if" | "fail-if". condition: the condition string. comment: the trailing "# ..."
//     comment of the condition's line. line: 1-based line in the manifest.
//     commit: {sha, date, author, subject} of the first commit whose diff adds or removes the condition's
//       line (`git log -S`, path-limited to the manifest), or null.
//     bug: the bug of that commit's subject, as {id, summary, firstComment} or {id, error}, or null.
//     commentBugs: same shape, for the bugs named in the comment ("# Bug 1787024").
//
//     The first commit is often not the one that added the skip: the .ini → .toml conversion (bug 1853243)
//     and mass manifest rewrites (bug 1995583, new os_version values) re-add every line. On
//     browser/components/sessionstore/test, most commits are such rewrites, and commentBugs is usually the
//     real source.
//
// Not done yet: whether a condition is dead (matches no CI configuration), and `write`.
//
// The TOML parsing is limited to what test manifests use: [sections], and skip-if / fail-if arrays of
// strings with trailing comments.

import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { runCli, UsageError } from "../lib/cli.ts";
import { exec } from "../lib/exec.ts";
import { bugInfo, type BugInfo } from "./bugzilla.ts";
import { repoArg } from "./phab.ts";

export type AnnotationKind = "skip-if" | "fail-if";

export interface ManifestAnnotation {
  test: string;
  kind: AnnotationKind;
  condition: string;
  comment?: string;
  line: number;
  lineText: string; // the manifest line, trimmed, for git log -S
}

export interface Commit {
  sha: string;
  date: string;
  author: string;
  subject: string;
}

export type BugRef = BugInfo | { id: number; error: string };

export interface Annotation {
  manifest: string;
  test: string;
  kind: AnnotationKind;
  condition: string;
  comment?: string;
  line: number;
  commit: Commit | null;
  bug: BugRef | null;
  commentBugs: BugRef[];
}

// Reads a TOML basic ("...") or literal ('...') string starting at s[i]; returns the value and the
// index after the closing quote.
function readString(s: string, i: number): [string, number] {
  const q = s[i];
  let out = "";
  i++;
  while (i < s.length && s[i] !== q) {
    if (q === '"' && s[i] === "\\") {
      const e = s[i + 1];
      const map: Record<string, string> = { n: "\n", t: "\t", '"': '"', "\\": "\\", r: "\r" };
      if (e === "u" || e === "U") {
        const len = e === "u" ? 4 : 8;
        out += String.fromCodePoint(parseInt(s.slice(i + 2, i + 2 + len), 16));
        i += 2 + len;
        continue;
      }
      out += map[e] ?? e;
      i += 2;
      continue;
    }
    out += s[i++];
  }
  return [out, i + 1];
}

export function parseManifest(text: string): ManifestAnnotation[] {
  const lines = text.split("\n");
  const out: ManifestAnnotation[] = [];
  let section = "DEFAULT";
  let n = 0;
  while (n < lines.length) {
    const line = lines[n];
    const header = /^\s*\[\s*(.*?)\s*\]\s*(#.*)?$/.exec(line);
    if (header) {
      const h = header[1];
      section = h.startsWith('"') || h.startsWith("'") ? readString(h, 0)[0] : h;
      n++;
      continue;
    }
    const key = /^\s*(skip-if|fail-if)\s*=\s*/.exec(line);
    if (!key) {
      n++;
      continue;
    }
    const kind = key[1] as AnnotationKind;
    const items: ManifestAnnotation[] = [];
    const single = !line.slice(key[0].length).startsWith("[");
    let i = key[0].length;
    let depth = single ? 1 : 0;
    // Scan from the "=" to the end of the line that closes the array, across lines.
    while (n < lines.length) {
      const l = lines[n];
      const onLine: ManifestAnnotation[] = [];
      while (i < l.length) {
        const c = l[i];
        if (c === '"' || c === "'") {
          const [value, next] = readString(l, i);
          const a: ManifestAnnotation = { test: section, kind, condition: value, line: n + 1, lineText: l.trim() };
          items.push(a);
          onLine.push(a);
          i = next;
        } else if (c === "#") {
          const comment = l.slice(i + 1).trim();
          for (const a of onLine) a.comment = comment;
          break;
        } else {
          if (c === "[") depth++;
          if (c === "]") depth--;
          i++;
        }
      }
      n++;
      i = 0;
      if (depth <= 0 || single) break;
    }
    out.push(...items);
  }
  return out;
}

const NOT_TEST_MANIFESTS = new Set(["Cargo.toml", "pyproject.toml", "rustfmt.toml", "taplo.toml", "config.toml"]);

export function findManifests(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith(".")) {
      out.push(...findManifests(p));
    } else if (e.isFile() && e.name.endsWith(".toml") && !NOT_TEST_MANIFESTS.has(e.name)) {
      out.push(p);
    }
  }
  return out.sort();
}

export type Git = (args: string[]) => Promise<string>;

export function gitIn(repo: string): Git {
  return async (args) => {
    const r = await exec(["git", ...args], { cwd: repo });
    if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`);
    return r.stdout;
  };
}

export function logArgs(lineText: string, manifest: string): string[] {
  return ["log", "--reverse", "--format=%H%x09%aI%x09%an%x09%s", "-S", lineText, "--", manifest];
}

export function parseFirstCommit(out: string): Commit | null {
  const first = out.split("\n").find((l) => l.trim() !== "");
  if (!first) return null;
  const [sha, date, author, ...subject] = first.split("\t");
  return { sha, date, author, subject: subject.join("\t") };
}

export function bugOfSubject(subject: string): number | null {
  const m = /\bbug\s*(\d{4,})/i.exec(subject);
  return m ? Number(m[1]) : null;
}

export function bugsOfComment(comment: string | undefined): number[] {
  return [...new Set([...(comment ?? "").matchAll(/\bbug\s*(\d{4,})/gi)].map((m) => Number(m[1])))];
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function list(folder: string, repo: string, deps: { git?: Git; fetch?: typeof fetch } = {}): Promise<Annotation[]> {
  const git = deps.git ?? gitIn(repo);
  const fetchFn = deps.fetch ?? fetch;
  const dir = isAbsolute(folder) ? folder : resolve(repo, folder);
  const found: { manifest: string; a: ManifestAnnotation }[] = [];
  for (const path of findManifests(dir)) {
    const manifest = relative(repo, path);
    for (const a of parseManifest(readFileSync(path, "utf8"))) found.push({ manifest, a });
  }

  // On a mozilla-central checkout each `git log -S` takes seconds; the same line often repeats.
  const commits = new Map<string, Promise<Commit | null>>();
  const commitOf = (manifest: string, lineText: string) => {
    const key = manifest + "\0" + lineText;
    if (!commits.has(key)) commits.set(key, git(logArgs(lineText, manifest)).then(parseFirstCommit));
    return commits.get(key)!;
  };
  const bugs = new Map<number, Promise<BugRef>>();
  const bugOf = (id: number) => {
    if (!bugs.has(id)) {
      bugs.set(
        id,
        bugInfo(id, fetchFn).catch((e: unknown) => ({ id, error: e instanceof Error ? e.message : String(e) })),
      );
    }
    return bugs.get(id)!;
  };

  return mapLimit(found, 4, async ({ manifest, a }) => {
    const commit = await commitOf(manifest, a.lineText);
    const bugId = commit ? bugOfSubject(commit.subject) : null;
    const out: Annotation = {
      manifest,
      test: a.test,
      kind: a.kind,
      condition: a.condition,
      line: a.line,
      commit,
      bug: bugId ? await bugOf(bugId) : null,
      commentBugs: await Promise.all(bugsOfComment(a.comment).map(bugOf)),
    };
    if (a.comment !== undefined) out.comment = a.comment;
    return out;
  });
}

async function main() {
  await runCli(
    {
      list: async (args, values) => {
        const repo = repoArg(values.repo);
        if (args.length !== 1 || !repo) throw new UsageError("usage: list <folder> [--repo <checkout>]");
        return list(args[0], repo);
      },
    },
    { repo: { type: "string" } },
  );
}

if (import.meta.main) {
  await main();
}
