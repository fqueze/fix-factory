// artifacts.ts: downloads a test job's logs and profiles from Taskcluster.
//
//   node src/cli/artifacts.ts fetch <taskId> [--run N] --into <dir>
//     → {taskId, run, state, files: [{kind, name, path, bytes, skipped?}], missing: [{name, reason}]}
//       kind: "log" (live_backing.log) | "errorsummary" | "test-profile" (profile_<test>.json[.gz],
//       including the retry's profile_<test>-2…) | "resource-profile" (profile_resource-usage.json).
//       name is the artifact's file name, and the file is saved as <dir>/<run>/<name>: a retried
//       task's runs each have their own logs.
//       state: the run's Taskcluster state. A run that hasn't finished (pending or running) is refused,
//       since its artifacts aren't all uploaded yet.
//       skipped: the file was already there (fetch is idempotent).
//       missing: a profile or error summary named by an `Artifact` marker of the resource-usage
//       profile that couldn't be downloaded, or no resource-usage profile at all (a job killed
//       before uploading it, or not a test job).
//       --run defaults to the task's latest run.
//
// The artifact listing is the primary source. The resource-usage profile's Artifact markers name
// every file the harness uploaded, so a profile missing from the listing is still found.

import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { log, runCli, UsageError } from "../lib/cli.ts";

export const QUEUE = "https://firefox-ci-tc.services.mozilla.com/api/queue/v1";
const TEST_INFO = "public/test_info/";

export type ArtifactKind = "log" | "errorsummary" | "test-profile" | "resource-profile";

export interface FetchedFile {
  kind: ArtifactKind;
  name: string;
  path: string;
  bytes: number;
  skipped?: boolean;
}

export interface FetchResult {
  taskId: string;
  run: number;
  state: string;
  files: FetchedFile[];
  missing: { name: string; reason: string }[];
}

export interface Artifact {
  name: string; // full artifact name, e.g. public/test_info/profile_resource-usage.json
  storageType?: string;
  contentType?: string;
}

export type Fetch = typeof fetch;

// Returns the kind of a full artifact name, or null for artifacts we don't download.
export function kindOf(name: string): ArtifactKind | null {
  if (name === "public/logs/live_backing.log") return "log";
  if (!name.startsWith(TEST_INFO)) return null;
  const base = name.slice(TEST_INFO.length);
  if (base.includes("/")) return null;
  if (base === "profile_resource-usage.json") return "resource-profile";
  if (/^profile_.+\.json(\.gz)?$/.test(base)) return "test-profile";
  if (/errorsummary\.log$/.test(base)) return "errorsummary";
  return null;
}

export function baseName(name: string): string {
  return name.slice(name.lastIndexOf("/") + 1);
}

async function getJson(url: string, fetchImpl: Fetch): Promise<unknown> {
  const res = await fetchImpl(url, { redirect: "follow", headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return res.json();
}

const FINISHED = new Set(["completed", "failed", "exception"]);

// The requested run (the latest by default) and its state.
export async function runState(taskId: string, run: number | undefined, fetchImpl: Fetch = fetch): Promise<{ run: number; state: string }> {
  const s = (await getJson(`${QUEUE}/task/${taskId}/status`, fetchImpl)) as { status: { runs?: { runId: number; state: string }[] } };
  const runs = s.status.runs ?? [];
  const r = run === undefined ? runs[runs.length - 1] : runs.find((x) => x.runId === run);
  if (!r) throw new Error(run === undefined ? `task ${taskId} has no runs` : `task ${taskId} has no run ${run}`);
  return { run: r.runId, state: r.state };
}

export async function listArtifacts(taskId: string, run: number, fetchImpl: Fetch = fetch): Promise<Artifact[]> {
  const out: Artifact[] = [];
  let token: string | undefined;
  do {
    const url = `${QUEUE}/task/${taskId}/runs/${run}/artifacts${token ? `?continuationToken=${encodeURIComponent(token)}` : ""}`;
    const page = (await getJson(url, fetchImpl)) as { artifacts: Artifact[]; continuationToken?: string };
    out.push(...page.artifacts);
    token = page.continuationToken;
  } while (token);
  return out;
}

// File names from the `Artifact` markers of a resource-usage profile, in either format the harness
// writes: a processed profile (one JSON document), or the streamed JSON lines a job killed for
// exceeding its max run time leaves behind.
export function artifactMarkerFilenames(text: string): string[] {
  const names = new Set<string>();
  const visit = (data: unknown) => {
    const d = data as { type?: string; filename?: unknown } | null;
    if (d && d.type === "Artifact" && typeof d.filename === "string") names.add(d.filename);
  };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    doc = undefined;
  }
  if (doc && typeof doc === "object" && "threads" in doc) {
    for (const th of (doc as { threads: { markers?: { data?: unknown[] } }[] }).threads) {
      for (const d of th.markers?.data ?? []) visit(d);
    }
  } else {
    for (const line of text.split("\n")) {
      if (!line.includes('"Artifact"')) continue;
      try {
        visit((JSON.parse(line) as { data?: unknown }).data);
      } catch {
        // The last line of a killed job's stream can be cut mid-write.
      }
    }
  }
  return [...names];
}

export function selectArtifacts(listing: Artifact[]): { name: string; kind: ArtifactKind }[] {
  const out: { name: string; kind: ArtifactKind }[] = [];
  for (const a of listing) {
    const kind = kindOf(a.name);
    if (kind) out.push({ name: a.name, kind });
  }
  return out;
}

// Downloads to a temporary name first, so an interrupted fetch never leaves a file that a rerun
// would skip as already downloaded.
async function download(url: string, dest: string, fetchImpl: Fetch): Promise<{ ok: true } | { ok: false; status: number }> {
  const res = await fetchImpl(url, { redirect: "follow" });
  if (!res.ok || !res.body) return { ok: false, status: res.status };
  const tmp = `${dest}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(tmp));
    renameSync(tmp, dest);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return { ok: true };
}

export function artifactUrl(taskId: string, run: number, name: string): string {
  return `${QUEUE}/task/${taskId}/runs/${run}/artifacts/${name.split("/").map(encodeURIComponent).join("/")}`;
}

export async function fetchArtifacts(
  taskId: string,
  opts: { run?: number; into: string; fetchImpl?: Fetch },
): Promise<FetchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { run, state } = await runState(taskId, opts.run, fetchImpl);
  if (!FINISHED.has(state)) throw new Error(`run ${run} of task ${taskId} is ${state}: fetch its artifacts once it has finished`);
  const dir = join(opts.into, String(run));
  mkdirSync(dir, { recursive: true });
  const listing = await listArtifacts(taskId, run, fetchImpl);
  const wanted = selectArtifacts(listing);
  const files: FetchedFile[] = [];
  const missing: FetchResult["missing"] = [];

  const get = async (name: string, kind: ArtifactKind): Promise<boolean> => {
    const base = baseName(name);
    const path = join(dir, base);
    if (existsSync(path)) {
      files.push({ kind, name: base, path, bytes: statSync(path).size, skipped: true });
      return true;
    }
    const r = await download(artifactUrl(taskId, run, name), path, fetchImpl);
    if (!r.ok) {
      missing.push({ name: base, reason: `HTTP ${r.status}` });
      return false;
    }
    files.push({ kind, name: base, path, bytes: statSync(path).size });
    log(`fetched ${base}`);
    return true;
  };

  // The resource-usage profile first: its markers tell what else should be there.
  const resource = wanted.find((w) => w.kind === "resource-profile");
  let markerNames: string[] = [];
  if (resource && (await get(resource.name, resource.kind))) {
    markerNames = artifactMarkerFilenames(readFileSync(join(dir, baseName(resource.name)), "utf8"));
  } else if (!resource) {
    missing.push({ name: "profile_resource-usage.json", reason: "not in the artifact listing" });
  }
  for (const w of wanted) {
    if (w !== resource) await get(w.name, w.kind);
  }
  const listed = new Set(wanted.map((w) => baseName(w.name)));
  for (const fileName of markerNames) {
    const name = TEST_INFO + fileName;
    const kind = kindOf(name);
    if (!kind || listed.has(fileName)) continue;
    log(`${fileName} is named by an Artifact marker but not in the listing; fetching it directly`);
    await get(name, kind);
  }
  return { taskId, run, state, files, missing };
}

if (import.meta.main) {
  await runCli(
    {
      fetch: async ([taskId], values) => {
        const into = values.into as string | undefined;
        if (!taskId || !into) throw new UsageError("usage: fetch <taskId> [--run N] --into <dir>");
        const run = values.run === undefined ? undefined : Number(values.run);
        if (run !== undefined && !Number.isInteger(run)) throw new UsageError(`--run must be a run number, got ${values.run}`);
        return fetchArtifacts(taskId, { run, into });
      },
    },
    { run: { type: "string" }, into: { type: "string" } },
  );
}
