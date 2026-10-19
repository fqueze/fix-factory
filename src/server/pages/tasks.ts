import type { TryJob } from "../../cli/task-set.ts";
import type { DryRunResult } from "../../cli/try.ts";
import { html, join, type Html } from "../html.ts";

// Without mach's task set, a label's platform, collection, group and symbol come from heuristics: tier 1, no chunk
// numbers for patterns. Label prefix of a test suite → its group and symbol, longest first when matching.
const SUITES: Record<string, [string, string]> = {
  "mochitest-plain": ["M", ""], "mochitest-plain-gpu": ["M", "gpu"], "mochitest-chrome": ["M", "c"], "mochitest-chrome-gpu": ["M", "gpu-c"],
  "mochitest-browser-chrome": ["M", "bc"], "mochitest-browser-a11y": ["M", "ba"], "mochitest-browser-media": ["M", "mda-bc"],
  "mochitest-devtools-chrome": ["M", "dt"], "mochitest-a11y": ["M", "a11y"], "mochitest-media": ["M", "mda"], "mochitest-remote": ["M", "remote"],
  xpcshell: ["X", "X"], reftest: ["R", "R"], crashtest: ["R", "C"], jsreftest: ["R", "J"],
  "web-platform-tests": ["W", "wpt"], "web-platform-tests-reftest": ["W", "Wr"], "web-platform-tests-wdspec": ["W", "Wd"],
  "web-platform-tests-crashtest": ["W", "Wc"], "web-platform-tests-print-reftest": ["W", "Wp"],
  marionette: ["Mn", ""], "marionette-unittest": ["Mn", "unit"], gtest: ["", "GTest"], cppunittest: ["", "cppunit"], jittest: ["", "Jit"],
};
const SUITE_NAMES = Object.keys(SUITES).sort((a, b) => b.length - a.length);

export function parseLabel(label: string): TryJob {
  const build = label.match(/^build-(.+)\/(\w+)$/);
  if (build) {
    return { label, platform: build[1], collection: build[2], group: "", symbol: "B", tier: 1 };
  }
  const test = label.match(/^test-(.+?)\/([a-z]+)-(.+)$/);
  const suite = test && SUITE_NAMES.find((s) => test[3] === s || test[3].startsWith(`${s}-`));
  if (!test || !suite) {
    return { label, platform: "other", collection: "opt", group: "", symbol: label, tier: 1 };
  }
  // What follows the suite: variants, then a chunk number, or * for every chunk.
  const rest = test[3].slice(suite.length + 1);
  const chunk = rest.match(/(?:^|-)(\d+|\*)$/);
  const suffix = (chunk ? rest.slice(0, chunk.index) : rest)
    .split("-")
    .filter(Boolean)
    .map((v) => `-${v === "standalone" ? "sa" : v}`)
    .join("");
  const [group, symbol] = SUITES[suite];
  return { label, platform: test[1], collection: test[2], group: group && group + suffix, symbol: (group ? symbol : symbol + suffix) + (chunk?.[1] ?? "") || "1", tier: 1 };
}

// Treeherder's names for machine platforms (thPlatformMap in its ui/helpers/constants.js), as rules: the OS and
// version, then the modifiers. x64 goes unsaid.
const OSES: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^linux(\d\d)(\d\d)-(32|64)/, (m) => `Linux ${m[1]}.${m[2]}${m[3] === "32" ? " x86" : ""}`],
  [/^linux64-aarch64/, () => "Linux AArch64"],
  [/^linux(64|32)?/, (m) => `Linux${m[1] === "32" ? " x86" : ""}`],
  [/^macosx(10|1\d|2\d)(\d\d)-(64|aarch64)/, (m) => `macOS ${m[1]}${m[2] === "00" ? "" : `.${m[2]}`}${m[3] === "aarch64" ? " AArch64" : ""}`],
  [/^(?:osx-cross|osx|macosx64)(-aarch64)?/, (m) => `macOS${m[1] ? " AArch64" : ""}`],
  [/^windows(\d\d)-(32|64|aarch64)(?:-(\d{4}|\d\dh\d))?/, (m) => `Windows ${m[1]}${m[2] === "32" ? " x86" : ""}${m[3] ? ` ${m[3].toUpperCase()}` : ""}${m[2] === "aarch64" ? " AArch64" : ""}`],
  [/^(?:windows2012|win)-?(32|64|aarch64)(-aarch64)?/, (m) => `Windows${m[1] === "32" ? " x86" : m[1] === "aarch64" || m[2] ? " AArch64" : ""}`],
  [/^android-em-(\d+)-x86_64/, (m) => `Android ${m[1]}.0 x86-64`],
  [/^android-5-0-(armv7|aarch64|x86_64|x86)/, (m) => `Android ${{ armv7: "ARMv7", aarch64: "AArch64", x86_64: "x86-64", x86: "x86" }[m[1]]}`],
];
const MODIFIERS: Record<string, string> = {
  qr: "", shippable: "Shippable", asan: "asan", tsan: "tsan", ccov: "CCov", devedition: "DevEdition", nightlyasrelease: "NightlyAsRelease",
  mingwclang: "MinGW", wayland: "Wayland", noopt: "NoOpt", lite: "Lite", snap: "Snap", hw: "Ref HW", ref: "", vms: "",
};
const NAMES: Record<string, string> = {
  "gecko-decision": "Gecko Decision Task", lint: "Linting", doc: "Documentation", toolchains: "Toolchains", fetch: "Fetch", diff: "Diffoscope",
  other: "Other", ios: "iOS", "AC-android-all": "Android Components", "fenix-android-all": "Fenix", "focus-android-all": "Focus Android",
};

export function platformName(p: string): string {
  for (const [re, name] of OSES) {
    const m = p.match(re);
    if (m) {
      const mods = p.slice(m[0].length).split("-").filter(Boolean);
      // Treeherder puts VM last: "macOS 15 AArch64 Shippable VM".
      return [name(m), ...mods.map((t) => MODIFIERS[t] ?? t), mods.includes("vms") ? "VM" : ""].filter(Boolean).join(" ");
    }
  }
  return NAMES[p] ?? p;
}

interface Group {
  symbol: string; // "" for jobs not in a group
  tier: number;
  jobs: TryJob[];
}

interface Row {
  name: string;
  collection: string;
  groups: Group[];
}

// Treeherder's thOptionOrder; its rows follow thPlatformMap, which lists builds first, then each OS by version.
const OPTION_ORDER: Record<string, number> = { opt: 1, pgo: 2, asan: 3, tsan: 4, debug: 5 };
const OS_ORDER = ["Linux", "macOS", "Windows", "Android"];
// Then build platforms (no OS version), which thPlatformMap lists before the test platforms, but after them on Windows.
function osRank(name: string): number {
  const i = OS_ORDER.findIndex((os) => name.startsWith(os));
  const build = !/^\S+ \d/.test(name);
  return (i < 0 ? OS_ORDER.length : i) * 2 + (build === (OS_ORDER[i] === "Windows") ? 1 : 0);
}
const alphaNum = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

export function rowsOf(jobs: TryJob[]): Row[] {
  const rows = new Map<string, Row>();
  for (const job of jobs) {
    const name = platformName(job.platform);
    const key = `${name} ${job.collection}`;
    const row = rows.get(key) ?? { name, collection: job.collection, groups: [] };
    rows.set(key, row);
    const group = row.groups.find((g) => g.symbol === job.group && g.tier === job.tier);
    if (group) {
      group.jobs.push(job);
    } else {
      row.groups.push({ symbol: job.group, tier: job.tier, jobs: [job] });
    }
  }
  for (const row of rows.values()) {
    // Like Treeherder: groups by symbol length and tier, so ungrouped jobs come first; jobs by symbol.
    row.groups.sort((a, b) => a.symbol.length + a.tier - b.symbol.length - b.tier || alphaNum(a.symbol, b.symbol));
    row.groups.forEach((g) => g.jobs.sort((a, b) => alphaNum(a.symbol, b.symbol)));
  }
  return [...rows.values()].sort(
    (a, b) => osRank(a.name) - osRank(b.name) || alphaNum(a.name, b.name) || (OPTION_ORDER[a.collection] ?? 10) - (OPTION_ORDER[b.collection] ?? 10),
  );
}

// What a planned try push would run, from its dry run, laid out like Treeherder's job view: loaded into its row
// when you open it. Each task appears once per run; builds are B, or Ba when they become artifact builds.
export function pushTasks(d: DryRunResult): Html {
  const config = d.tryTaskConfig;
  const artifact = config["use-artifact-builds"] === true;
  const rebuild = (config.rebuild as number | Record<string, number> | undefined) ?? 1;
  const jobs = d.jobs ?? d.tasks.map(parseLabel);
  // The builds the tests need run once. A per-label rebuild names the selected label, which may be the job's chunk pattern.
  const builds = new Set(jobs.map((j) => j.build));
  const runsOf = (j: TryJob) => (builds.has(j.label) ? 1 : typeof rebuild === "number" ? rebuild : (rebuild[j.label] ?? rebuild[j.label.replace(/-\d+$/, "-*")] ?? 1));
  const symbol = (j: TryJob) => (artifact && j.artifact ? `${j.symbol}a` : j.symbol);
  const jobHtml = (j: TryJob) => {
    const s = html`<span class="job" title="${j.label}${artifact && j.artifact ? " (artifact build)" : ""}">${symbol(j)}</span>`;
    return join(Array.from({ length: runsOf(j) }, () => s), " ");
  };
  const tier = (g: Group) => (g.tier > 1 ? html`<span class="tier">[tier ${g.tier}]</span>` : null);
  return html`<table class="jobs">${rowsOf(jobs).map(
    (row) =>
      html`<tr><th>${row.name} <span class="btype">${row.collection}</span></th><td>${join(
        row.groups.map((g) =>
          g.symbol
            ? html`<span class="jgroup">${tier(g)}${g.symbol}( ${join(g.jobs.map(jobHtml), " ")} )</span>`
            : html`${tier(g)}${join(g.jobs.map(jobHtml), " ")}`,
        ),
        " ",
      )}</td></tr>`,
  )}</table>
<pre class="mono command">${d.command.join(" ")}</pre>
<pre class="mono ttc" title="The try_task_config.json it would push">${JSON.stringify(config, null, 2)}</pre>`;
}
