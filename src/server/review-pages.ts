// The review pages served from md-viewer's API (its lib/api.js), when the stack-viewer the factory runs has one: the
// stack page is built from the commits' sources alone, and each commit's page when the stack page fetches it, the
// one it opens on first and the others in the background. Running stack-viewer instead builds every commit's page
// before the stack's can be sent.
//
// What a sha names never changes, so its source, its files' versions and its page (for the same annotation) are
// kept, up to a bound.
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

interface Patch {
  sha: string;
  label: string;
  source: string;
}

interface Stack {
  root: string;
  list(revset: string): Promise<{ sha: string; label: string }[]>;
}

// md-viewer's lib/api.js, as far as the factory uses it.
export interface ReviewApi {
  findStackRepository(dir: string): { root: string; kind: string } | null;
  openStack(found: { root: string; kind: string }): Promise<Stack>;
  readStack(stack: Stack, commits: { sha: string; label: string }[]): Promise<Patch[]>;
  readFileVersions(stack: Stack, patches: Patch[]): Promise<Record<string, unknown>[]>;
  commitSummary(patch: Patch): unknown;
  buildStackShell(commits: unknown[], opts: { title: string; where: string; annotations: unknown; pageUrl: (i: number) => string; assetUrl: (name: string) => string }): Promise<string>;
  buildCommitPage(patch: Patch & { versions?: unknown }, opts: { annotation: unknown; annotated: boolean; assetUrl: (name: string) => string }): Promise<string>;
  assetText(name: string): Promise<string>;
}

// The API next to the stack-viewer a command runs (tools/bin/stack-viewer links md-viewer-at/<rev>/stack-viewer.js),
// with a name for its version that changes with it; none for a command that isn't one file, or a viewer without it.
const apis = new Map<string, Promise<{ api: ReviewApi; rev: string } | undefined>>();

export function reviewApi(command: string[]): Promise<{ api: ReviewApi; rev: string } | undefined> {
  if (command.length !== 1 || !existsSync(command[0])) return Promise.resolve(undefined);
  const dir = dirname(realpathSync(command[0]));
  const file = join(dir, "lib", "api.js");
  if (!apis.has(file)) {
    const rev = createHash("sha256").update(`${dir}:${basename(dir)}`).digest("hex").slice(0, 12);
    apis.set(file, existsSync(file) ? import(pathToFileURL(file).href).then((api: ReviewApi) => ({ api, rev })) : Promise.resolve(undefined));
  }
  return apis.get(file)!;
}

// A map that forgets its oldest entries past `max`.
function bounded<V>(max: number) {
  const map = new Map<string, V>();
  return {
    get: (k: string) => map.get(k),
    has: (k: string) => map.has(k),
    set(k: string, v: V) {
      map.delete(k);
      map.set(k, v);
      while (map.size > max) map.delete(map.keys().next().value!);
    },
  };
}

export function reviewPages(api: ReviewApi) {
  const sources = bounded<Patch>(2000);
  const versions = bounded<Record<string, unknown>>(300);
  const pages = bounded<string>(300);
  const stacks = new Map<string, Promise<Stack>>();

  function stackIn(dir: string): Promise<Stack> {
    if (!stacks.has(dir)) {
      const found = api.findStackRepository(dir);
      if (!found) return Promise.reject(new Error(`${dir} is not in a git repository`));
      const opened = api.openStack(found);
      // A worktree removed since: opened again next time.
      opened.catch(() => stacks.delete(dir));
      stacks.set(dir, opened);
    }
    return stacks.get(dir)!;
  }

  async function read(stack: Stack, commits: { sha: string; label: string }[]): Promise<Patch[]> {
    const missing = commits.filter((c) => !sources.has(c.sha));
    if (missing.length) for (const p of await api.readStack(stack, missing)) sources.set(p.sha, p);
    return commits.map((c) => ({ ...sources.get(c.sha)!, label: c.label }));
  }

  return {
    // The stack page for `range` in `dir`: its commits, oldest first, and their pages at pageUrl(sha).
    async shell(o: { dir: string; range: string; title: string; annotations: unknown; pageUrl: (sha: string) => string; assetUrl: (name: string) => string }): Promise<{ html: string; shas: string[] }> {
      const stack = await stackIn(o.dir);
      const patches = await read(stack, await stack.list(o.range));
      const html = await api.buildStackShell(patches.map((p) => api.commitSummary(p)), {
        title: o.title,
        where: stack.root,
        annotations: o.annotations,
        pageUrl: (i) => o.pageUrl(patches[i].sha),
        assetUrl: o.assetUrl,
      });
      return { html, shas: patches.map((p) => p.sha) };
    },
    // One commit's page, with its annotation as it is now.
    async page(o: { dir: string; sha: string; annotation: unknown; annotated: boolean; assetUrl: (name: string) => string }): Promise<string> {
      const key = `${o.sha}:${o.annotated}:${createHash("sha256").update(JSON.stringify(o.annotation ?? null)).digest("hex")}`;
      const kept = pages.get(key);
      if (kept !== undefined) return kept;
      const stack = await stackIn(o.dir);
      const [patch] = await read(stack, [{ sha: o.sha, label: o.sha.slice(0, 12) }]);
      if (!versions.has(o.sha)) versions.set(o.sha, (await api.readFileVersions(stack, [patch]))[0]);
      const html = await api.buildCommitPage({ ...patch, versions: versions.get(o.sha) }, { annotation: o.annotation, annotated: o.annotated, assetUrl: o.assetUrl });
      pages.set(key, html);
      return html;
    },
    asset: (name: string) => api.assetText(name),
  };
}

export type ReviewPages = ReturnType<typeof reviewPages>;
