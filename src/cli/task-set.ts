// The tasks a try push would run, as Treeherder will show them: from the graph the decision task would make
// (`mach taskgraph target-graph` with the push's parameters), or else from the task set that `mach try` cached
// for the worktree, which has the default chunk counts: it's made without loading the test manifests.

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { exec } from "../lib/exec.ts";

export interface TryJob {
  label: string;
  platform: string; // Treeherder's machine.platform, e.g. linux2404-64-shippable
  collection: string; // opt, debug, asan…
  group: string; // "" when not in a group
  symbol: string;
  tier: number;
  build?: string; // the label of the build a test needs
  artifact?: true; // a build that becomes an artifact build under use-artifact-builds (from the task set: the graph says Ba already)
}

// mach's get_state_dir(specific_to_topsrcdir=True), then tryselect's cache.
export function taskSetPath(topsrcdir: string, full: boolean, stateDir = process.env.MOZBUILD_STATE_PATH ?? join(homedir(), ".mozbuild")): string {
  const src = realpathSync(topsrcdir);
  const hash = createHash("sha256").update(src).digest("hex").slice(0, 12);
  return join(stateDir, "srcdirs", `${basename(src)}-${hash}`, "cache", "taskgraph", full ? "full_task_set" : "target_task_set");
}

// mozbuild's artifact_builds JOB_CHOICES.
const ARTIFACT_JOBS = new Set(
  ["android-arm", "android-x86_64", "android-aarch64", "linux64", "linux64-aarch64", "macosx64", "macosx64-aarch64", "win32", "win64", "win64-aarch64"].flatMap((p) => [`${p}-opt`, `${p}-debug`]),
);

// The task set is one JSON object, label → task, written by json.dump without spaces: `{"label":{"kind":…},"label":…}`.
// The full set is 340 MB, so rather than parsing it all, find where each task is and parse only the ones needed.
const MARKER = Buffer.from('":{"kind":"');

function indexTasks(buf: Buffer): Map<string, [number, number]> {
  const starts: [string, number][] = [];
  for (let at = buf.indexOf(MARKER); at !== -1; at = buf.indexOf(MARKER, at + MARKER.length)) {
    const quote = buf.lastIndexOf(0x22, at - 1);
    starts.push([buf.toString("utf8", quote + 1, at), quote]);
  }
  const index = new Map<string, [number, number]>();
  starts.forEach(([label, quote], i) => {
    // Up to the comma before the next label, or the object's closing brace.
    const end = i + 1 < starts.length ? starts[i + 1][1] - 1 : buf.lastIndexOf(0x7d);
    index.set(label, [quote + label.length + 3, end]);
  });
  return index;
}

interface Task {
  attributes: { build_platform?: string; build_type?: string; always_target?: boolean };
  dependencies: Record<string, string>;
  task: { extra?: { treeherder?: { machine: { platform: string }; collection: Record<string, boolean>; groupSymbol?: string; symbol: string; tier?: number; jobKind?: string } } };
}

// fromGraph: the task is from a graph made with the push's parameters, so its symbol is already Ba for an artifact build.
function jobOf(label: string, t: Task, fromGraph: boolean): TryJob {
  const th = t.task.extra!.treeherder!;
  const artifact = !fromGraph && th.jobKind === "build" && ARTIFACT_JOBS.has(`${t.attributes.build_platform}-${t.attributes.build_type}`);
  const build = t.dependencies.build;
  return {
    label, platform: th.machine.platform, collection: Object.keys(th.collection)[0], group: th.groupSymbol ?? "", symbol: th.symbol, tier: th.tier ?? 1,
    ...(build ? { build } : {}), ...(artifact ? { artifact: true as const } : {}),
  };
}

// The jobs of the labels, each followed by the build it needs when that isn't listed yet.
function jobsWithBuilds(labels: string[], task: (label: string) => Task | undefined, fromGraph = false): TryJob[] {
  const jobs = new Map<string, TryJob>();
  for (const label of labels) {
    const j = jobOf(label, task(label)!, fromGraph);
    jobs.set(label, j);
    const build = j.build && !jobs.has(j.build) && task(j.build);
    if (build) {
      jobs.set(j.build!, jobOf(j.build!, build, fromGraph));
    }
  }
  return [...jobs.values()];
}

// Like gecko's _try_task_config: a pattern (label-*) is every label it has with a chunk number, or the label without one
// when there is a single chunk. The decision task may then drop chunks; only its graph tells.
export function expandLabels(selected: string[], labels: Iterable<string>): string[] {
  const all = [...labels];
  const out = new Set(selected.filter((t) => !t.endsWith("-*")));
  for (const pattern of selected.filter((t) => t.endsWith("-*"))) {
    const prefix = pattern.slice(0, -1);
    let found = all.filter((l) => l.startsWith(prefix) && /^\d+$/.test(l.slice(prefix.length)));
    if (!found.length && all.includes(prefix.slice(0, -1))) {
      found = [prefix.slice(0, -1)];
    }
    found.forEach((l) => out.add(l));
  }
  return [...out];
}

function readTaskSet(file: string) {
  const buf = readFileSync(file);
  const index = indexTasks(buf);
  return {
    labels: () => index.keys(),
    task: (label: string): Task | undefined => {
      const at = index.get(label);
      return at && (JSON.parse(buf.toString("utf8", at[0], at[1])) as Task);
    },
    // Each task starts with {"kind":"
    kind: (label: string): string | undefined => {
      const at = index.get(label);
      return at && buf.toString("utf8", at[0] + 9, buf.indexOf(0x22, at[0] + 9));
    },
  };
}

// The jobs of the selected labels, and the builds they need. Throws when the file can't be read or parsed.
export function readJobs(file: string, selected: string[]): TryJob[] {
  const set = readTaskSet(file);
  return jobsWithBuilds(expandLabels(selected, set.labels()).filter((l) => set.task(l)), set.task);
}

// The kinds of the selected labels, for mach taskgraph to generate only those (and what they depend on).
export function readKinds(file: string, selected: string[]): string[] {
  const set = readTaskSet(file);
  return [...new Set(expandLabels(selected, set.labels()).flatMap((l) => set.kind(l) ?? []))].sort();
}

// The jobs of a dry run in a worktree, or undefined when mach's cache of its task set is missing or unreadable.
export function dryRunJobs(cwd: string, args: string[], tryTaskConfig: Record<string, unknown>, stateDir?: string): TryJob[] | undefined {
  try {
    return readJobs(taskSetPath(cwd, args.includes("--full"), stateDir), (tryTaskConfig.tasks as string[] | undefined) ?? []);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The decision task's graph

export type TaskGraph = Record<string, Task>;

// Whether the graph's label is what the selected label asked for: one of the chunks of a pattern, the label itself, or
// another chunk count of the same task (the decision task renumbers the chunks that no longer exist).
function answers(selected: string, label: string): boolean {
  const base = selected.endsWith("-*") ? selected.slice(0, -2) : selected.replace(/-\d+$/, "");
  return label === selected || label === base || (label.startsWith(`${base}-`) && /^\d+$/.test(label.slice(base.length + 1)));
}

// The jobs of a target graph (`mach taskgraph target-graph --json`): its target tasks, which nothing else in it
// needs, without those every try push adds (always_target docker images, which are cached), and the builds they
// need. dropped: the selected labels with nothing in the graph, which won't run.
export function graphJobs(graph: TaskGraph, selected: string[]): { jobs: TryJob[]; dropped: string[] } {
  const needed = new Set(Object.values(graph).flatMap((t) => Object.values(t.dependencies)));
  const exact = new Set(selected);
  const targets = Object.keys(graph).filter((l) => exact.has(l) || (!needed.has(l) && !graph[l].attributes.always_target));
  return {
    jobs: jobsWithBuilds(targets, (l) => graph[l], true),
    dropped: selected.filter((s) => !targets.some((l) => answers(s, l))),
  };
}

// The parameters the decision task would have for the push: mach try's, over the try project's, with the files
// the stack changes (which chunk counts of test-verify depend on).
export function decisionParameters(parameters: Record<string, unknown>, filesChanged: string[]): Record<string, unknown> {
  return {
    project: "try",
    level: "1",
    target_tasks_method: "try_tasks",
    enable_always_target: true,
    release_type: "nightly",
    files_changed: filesChanged,
    ...parameters,
    try_mode: "try_task_config",
  };
}

// The jobs of a dry run from the graph the decision task would make, with its manifests and chunks. Takes 10 to
// 20 s. Throws when mach fails.
export async function taskgraphJobs(
  cwd: string,
  args: string[],
  parameters: Record<string, unknown>,
  filesChanged: string[],
  opts: { exec?: typeof exec; stateDir?: string; timeoutS?: number } = {},
): Promise<{ jobs: TryJob[]; dropped: string[] }> {
  const selected = ((parameters.try_task_config as Record<string, unknown> | undefined)?.tasks as string[] | undefined) ?? [];
  let kinds: string[] = [];
  try {
    kinds = readKinds(taskSetPath(cwd, args.includes("--full"), opts.stateDir), selected);
  } catch {
    // Without mach's cache, every kind: slower, same graph.
  }
  const dir = mkdtempSync(join(tmpdir(), "ff-taskgraph-"));
  try {
    const params = join(dir, "parameters.json");
    const out = join(dir, "target-graph.json");
    writeFileSync(params, JSON.stringify(decisionParameters(parameters, filesChanged)));
    const timeoutS = String(opts.timeoutS ?? 600);
    const cmd = ["timeout", "--kill-after=30", timeoutS, "./mach", "taskgraph", "target-graph", "-p", params, ...kinds.flatMap((k) => ["-k", k]), "--json", "-o", out];
    const r = await (opts.exec ?? exec)(cmd, { cwd });
    if (r.code !== 0) {
      throw new Error(`mach taskgraph target-graph exited with ${r.code}: ${(r.stdout + r.stderr).trim().slice(-1000)}`);
    }
    return graphJobs(JSON.parse(readFileSync(out, "utf8")) as TaskGraph, selected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
