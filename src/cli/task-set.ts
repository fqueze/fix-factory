// The tasks a try push would run, as Treeherder will show them, from the task set
// that `mach try` cached for the worktree.

import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export interface TryJob {
  label: string;
  platform: string; // Treeherder's machine.platform, e.g. linux2404-64-shippable
  collection: string; // opt, debug, asan…
  group: string; // "" when not in a group
  symbol: string;
  tier: number;
  build?: string; // the label of the build a test needs
  artifact?: true; // a build that becomes an artifact build under use-artifact-builds
}

// mach's get_state_dir(specific_to_topsrcdir=True), then tryselect's cache.
export function taskSetPath(topsrcdir: string, full: boolean, stateDir = process.env.MOZBUILD_STATE_PATH ?? join(homedir(), ".mozbuild")): string {
  const src = realpathSync(topsrcdir);
  const hash = createHash("sha256").update(src).digest("hex").slice(0, 12);
  return join(stateDir, "srcdirs", `${basename(src)}-${hash}`, "cache", "taskgraph", full ? "full_task_set" : "target_task_set");
}

// mozbuild's artifact_builds JOB_CHOICES.
const ARTIFACT_JOBS = new Set(
  ["android-arm", "android-x86_64", "android-aarch64", "linux64", "linux64-aarch64", "macosx64", "win32", "win64", "win64-aarch64"]
    .flatMap((p) => [`${p}-opt`, `${p}-debug`])
    .concat("macosx64-aarch64-debug"),
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
  attributes: { build_platform?: string; build_type?: string };
  dependencies: Record<string, string>;
  task: { extra?: { treeherder?: { machine: { platform: string }; collection: Record<string, boolean>; groupSymbol?: string; symbol: string; tier?: number; jobKind?: string } } };
}

// Like gecko's _try_task_config: a pattern (label-*) is every label it has with a chunk number, or the label without one
// when there is a single chunk. With test paths or a tag, only the first chunk runs: it runs them all.
export function expandLabels(selected: string[], labels: Iterable<string>, env: Record<string, string> = {}): string[] {
  const all = [...labels];
  const out = new Set(selected.filter((t) => !t.endsWith("-*")));
  const firstOnly = "MOZHARNESS_TEST_PATHS" in env || "MOZHARNESS_TEST_TAG" in env;
  for (const pattern of selected.filter((t) => t.endsWith("-*"))) {
    const prefix = pattern.slice(0, -1);
    let found = all.filter((l) => l.startsWith(prefix) && /^\d+$/.test(l.slice(prefix.length)));
    if (!found.length && all.includes(prefix.slice(0, -1))) {
      found = [prefix.slice(0, -1)];
    }
    for (const l of found) {
      if (!firstOnly || l.endsWith("-1") || !/-\d+$/.test(l)) {
        out.add(l);
      }
    }
  }
  return [...out];
}

// The jobs of the selected labels, and the builds they need. Throws when the file can't be read or parsed.
export function readJobs(file: string, selected: string[], env: Record<string, string> = {}): TryJob[] {
  const buf = readFileSync(file);
  const index = indexTasks(buf);
  const task = (label: string): Task => {
    const [start, end] = index.get(label)!;
    return JSON.parse(buf.toString("utf8", start, end)) as Task;
  };
  const job = (label: string, t: Task): TryJob => {
    const th = t.task.extra!.treeherder!;
    const artifact = th.jobKind === "build" && ARTIFACT_JOBS.has(`${t.attributes.build_platform}-${t.attributes.build_type}`);
    const build = t.dependencies.build;
    return {
      label, platform: th.machine.platform, collection: Object.keys(th.collection)[0], group: th.groupSymbol ?? "", symbol: th.symbol, tier: th.tier ?? 1,
      ...(build ? { build } : {}), ...(artifact ? { artifact: true as const } : {}),
    };
  };
  const jobs = new Map<string, TryJob>();
  for (const label of expandLabels(selected, index.keys(), env).filter((l) => index.has(l))) {
    const j = job(label, task(label));
    jobs.set(label, j);
    if (j.build && !jobs.has(j.build) && index.has(j.build)) {
      jobs.set(j.build, job(j.build, task(j.build)));
    }
  }
  return [...jobs.values()];
}

// The jobs of a dry run in a worktree, or undefined when mach's cache of its task set is missing or unreadable.
export function dryRunJobs(cwd: string, args: string[], tryTaskConfig: Record<string, unknown>, stateDir?: string): TryJob[] | undefined {
  try {
    return readJobs(taskSetPath(cwd, args.includes("--full"), stateDir), (tryTaskConfig.tasks as string[] | undefined) ?? [], tryTaskConfig.env as Record<string, string> | undefined);
  } catch {
    return undefined;
  }
}
