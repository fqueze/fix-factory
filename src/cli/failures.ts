// failures.ts: everything built on `fx-tests --json`.
//
//   node src/cli/failures.ts collect <rev|folder>
//     → CollectedFailure[]: [{test, config, message, taskIds, count, rate?, rateScope?, failPercent?, runs?}]
//       taskIds: every failing task for a try push, the MAX_TASK_IDS most recent for a folder.
//       One entry per (test, config, message). `config` is the job name without its chunk number.
//       For a folder (mozilla-central history, fx-tests' 21-day window): count = failures in the window,
//       rate = failures per week, failPercent = % of that config's runs failing with this message.
//       For a try revision: count = failing runs on the push; rate and failPercent are the test's
//       central history on that config (any message), so they say how much fixing it is worth.
//
//   node src/cli/failures.ts history <test>
//     → {test, harness, window: {start, end, days}, totals: {runs, failures, failPercent},
//        configs: [{config, runs, failures, failPercent, recentFailPercent, perWeek, firstSeen?, lastSeen?}],
//        daily: [{date, runs, failures}], firstSeen: date|null, firstSeenAtWindowStart: boolean,
//        trend: "none" | "new" | "rising" | "falling" | "stable"}
//
//   node src/cli/failures.ts cluster <failures.json|->
//     → {groups: ClusterGroup[], singles: ClusterGroup[]}
//       ClusterGroup = FailureGroup & {key}: `key` is the normalized message.
//       `groups`: failures sharing a specific normalized message, across tests.
//       `singles`: one group per test for its generic failures (see GENERIC_MESSAGES), never merged
//       across tests.
//
//   node src/cli/failures.ts try-table <rev> [--test <path>]...
//     → TryTable: {rev, pushId, project, complete, pending, configs, rows, unparsed}
//       rows: [{test, config, result: "pass"|"fail"|"not-run", failures: [message], taskIds, passedOnRerun?, passTaskIds?}]
//       unparsed: [{taskId, retryId, jobName, config, result, reason}]
//       Rows cover every test that failed somewhere on the push, plus the --test ones, on each config
//       of their suite the push targeted. "not-run" = no recorded execution there (skipped, pending,
//       not scheduled, or in a job whose results fx-tests couldn't read): absence is never a pass.
//       unparsed = failed jobs where fx-tests attributed no failure to any test (harness crash, hang
//       with no test_end, setup failure, killed for exceeding max run time), finished test jobs fx-tests
//       couldn't read even if green, and failed non-test jobs. Runs with result "retry" are superseded
//       by their rerun and ignored.

import { readFileSync } from "node:fs";
import { execJson } from "../lib/exec.ts";
import { log, runCli, UsageError } from "../lib/cli.ts";
import type { FailureGroup } from "../types.ts";

// ---------------------------------------------------------------------------
// Running fx-tests

export type FxRunner = (args: string[]) => Promise<unknown>;

export const runFxTests: FxRunner = (args) => execJson(["fx-tests", ...args, "--json", "--quiet"]);

export type JsonFetcher = (url: string) => Promise<unknown>;

export const fetchJson: JsonFetcher = async (url) => {
  const res = await fetch(url, { headers: { "User-Agent": "fix-factory", Accept: "application/json" }, redirect: "follow" });
  if (!res.ok) {
    throw new Error(`GET ${url}: HTTP ${res.status}`);
  }
  return res.json();
};

export interface Deps {
  fx: FxRunner;
  fetchJson: JsonFetcher;
  concurrency?: number;
}

const defaultDeps: Deps = { fx: runFxTests, fetchJson };

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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

// ---------------------------------------------------------------------------
// The parts of fx-tests' JSON we read

interface FxTaskRef {
  taskId: string;
  retryId: number;
  jobName: string;
}

interface FxTryFailure {
  path: string;
  jobNames: string[];
  messages: string[];
  allMessages?: { message: string; count: number }[];
  statuses: string[];
  taskIds?: FxTaskRef[];
}

interface FxTry {
  revision: string;
  pushId: number;
  project: string;
  unblamedJobCount?: number;
  permaFails: FxTryFailure[];
  knownIntermittents: FxTryFailure[];
  newIntermittents: FxTryFailure[];
}

interface FxTaskFailure {
  path: string;
  failureCount: number;
  statuses: string[];
  passedOnRerun: boolean;
  messages: string[];
  allMessages?: { message: string; count: number }[];
}

interface FxTask {
  taskId: string;
  retryId: number;
  jobName: string;
  failures: FxTaskFailure[];
  passed?: { path: string; statuses: string[] }[];
}

interface FxTestConfig {
  jobName: string;
  runCount: number;
  failCount: number;
  failRate: number;
  recentFailRate?: number;
}

interface FxTestTaskId {
  taskId: string;
  retryId: number;
  jobName: string;
  status: string;
  day: string;
  message: string | null;
  occurrences?: number;
}

interface FxTest {
  path: string;
  harness: string;
  metadata: { startDate: string; endDate: string; dayCount: number };
  totals: { runCount: number; failCount: number; timeoutCount: number; crashCount: number };
  configs: FxTestConfig[];
  taskIds?: FxTestTaskId[];
  history?: { date: string; pass: number; fail: number; timeout: number; crash: number; skip: number }[];
}

interface FxFlaky {
  rows: { path: string; flaky: number; windowFailures: number }[];
}

function tryFailures(t: FxTry): FxTryFailure[] {
  return [...(t.permaFails ?? []), ...(t.knownIntermittents ?? []), ...(t.newIntermittents ?? [])];
}

// ---------------------------------------------------------------------------
// Shared helpers

// "test-android-em-14-x86_64/opt-geckoview-xpcshell-2" → "test-android-em-14-x86_64/opt-geckoview-xpcshell".
// A test runs in one chunk only, so per-test results are per config, not per chunk.
export function configOf(jobName: string): string {
  return jobName.replace(/-\d+$/, "");
}

// The suite a config runs, without platform and build type: "test-linux2404-64/opt-xpcshell" → "xpcshell".
export function suiteOf(config: string): string {
  const after = config.slice(config.indexOf("/") + 1);
  return after.replace(/^[a-z0-9]+-/, "");
}

// fx-tests leaves the message empty when the log had none (timeouts and crashes, mostly).
export function placeholderMessage(statuses: string[]): string {
  const s = statuses.map((x) => x.replace(/-(PARALLEL|SEQUENTIAL)$/, ""));
  if (s.includes("TIMEOUT")) return "Test timed out";
  if (s.includes("CRASH")) return "application crashed";
  if (s.includes("UNEXPECTED-PASS")) return "unexpected pass";
  return `(no message recorded, status ${s.join("/") || "unknown"})`;
}

function messagesOf(f: { messages?: string[]; allMessages?: { message: string }[]; statuses: string[] }): string[] {
  const all = f.allMessages?.length ? f.allMessages.map((m) => m.message) : (f.messages ?? []);
  const nonEmpty = all.filter((m) => m && m.trim());
  return nonEmpty.length ? [...new Set(nonEmpty)] : [placeholderMessage(f.statuses)];
}

function round(n: number, digits = 2): number {
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

// ---------------------------------------------------------------------------
// collect

export interface CollectedFailure {
  test: string;
  config: string;
  message: string;
  taskIds: string[]; // for a folder, the MAX_TASK_IDS most recent
  count: number;
  rate?: number; // failures per week
  rateScope?: "message" | "test"; // what rate counts: failures with this message, or any failure of the test
  failPercent?: number;
  runs?: number;
}

export function looksLikeRevision(arg: string): boolean {
  return /^[0-9a-f]{12,40}$/i.test(arg);
}

export async function collect(target: string, deps: Deps = defaultDeps): Promise<CollectedFailure[]> {
  return looksLikeRevision(target) ? collectTry(target, deps) : collectFolder(target, deps);
}

export async function collectFolder(folder: string, deps: Deps = defaultDeps): Promise<CollectedFailure[]> {
  const prefix = folder.replace(/\/+$/, "");
  const flaky = (await deps.fx(["flaky", prefix, "--limit", "0"])) as FxFlaky;
  const tests = flaky.rows.filter((r) => r.flaky > 0 || r.windowFailures > 0).map((r) => r.path);
  log(`collect: ${tests.length} failing tests under ${prefix}`);
  const perTest = await mapLimit(tests, deps.concurrency ?? 8, async (path) => {
    const t = (await deps.fx(["test", path, "--task-ids", "--limit", "0"])) as FxTest;
    return failuresFromHistory(t);
  });
  return perTest.flat();
}

// A folder's history can have hundreds of failing tasks per entry; the most recent are enough to
// fetch logs and profiles from.
export const MAX_TASK_IDS = 20;

export function failuresFromHistory(t: FxTest): CollectedFailure[] {
  const days = t.metadata.dayCount || 1;
  const runsByConfig = new Map<string, number>();
  for (const c of t.configs) {
    const k = configOf(c.jobName);
    runsByConfig.set(k, (runsByConfig.get(k) ?? 0) + c.runCount);
  }
  const byKey = new Map<string, CollectedFailure>();
  const byDay = [...(t.taskIds ?? [])].sort((a, b) => a.day.localeCompare(b.day));
  for (const x of byDay) {
    const config = configOf(x.jobName);
    const message = x.message && x.message.trim() ? x.message : placeholderMessage([x.status]);
    const key = `${config}\n${message}`;
    let f = byKey.get(key);
    if (!f) {
      f = { test: t.path, config, message, taskIds: [], count: 0 };
      byKey.set(key, f);
    }
    f.count += x.occurrences ?? 1;
    if (!f.taskIds.includes(x.taskId)) f.taskIds.push(x.taskId);
  }
  for (const f of byKey.values()) {
    f.taskIds = f.taskIds.slice(-MAX_TASK_IDS);
    f.rate = round((f.count / days) * 7);
    f.rateScope = "message";
    const runs = runsByConfig.get(f.config);
    if (runs) {
      f.runs = runs;
      f.failPercent = round((100 * f.count) / runs);
    }
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count);
}

export async function collectTry(rev: string, deps: Deps = defaultDeps): Promise<CollectedFailure[]> {
  const t = (await deps.fx(["try", rev, "--all-jobs", "--limit", "0", "--task-ids", "--messages"])) as FxTry;
  const failures = tryFailures(t);
  const tasks = new Map<string, FxTaskRef>();
  for (const f of failures) for (const x of f.taskIds ?? []) tasks.set(`${x.taskId}.${x.retryId}`, x);
  const taskOutputs = await mapLimit([...tasks.keys()], deps.concurrency ?? 8, async (id) => {
    try {
      return (await deps.fx(["task", id, "--limit", "0", "--messages"])) as FxTask;
    } catch (e) {
      log(`collect: fx-tests task ${id} failed: ${(e as Error).message}`);
      return null;
    }
  });
  const byKey = new Map<string, CollectedFailure>();
  const add = (test: string, jobName: string, message: string, taskId: string, n: number) => {
    const config = configOf(jobName);
    const key = `${test}\n${config}\n${message}`;
    let f = byKey.get(key);
    if (!f) {
      f = { test, config, message, taskIds: [], count: 0 };
      byKey.set(key, f);
    }
    f.count += n;
    if (!f.taskIds.includes(taskId)) f.taskIds.push(taskId);
  };
  const readTasks = new Set<string>();
  for (const out of taskOutputs) {
    if (!out) continue;
    readTasks.add(`${out.taskId}.${out.retryId}`);
    for (const f of out.failures) {
      const msgs = f.allMessages?.length ? f.allMessages : messagesOf(f).map((message) => ({ message, count: f.failureCount }));
      for (const m of msgs) add(f.path, out.jobName, m.message || placeholderMessage(f.statuses), out.taskId, m.count || 1);
    }
  }
  // A job fx-tests task couldn't read: fall back to the push view, which can't say which message
  // came from which job.
  for (const f of failures) {
    for (const x of f.taskIds ?? []) {
      if (readTasks.has(`${x.taskId}.${x.retryId}`)) continue;
      for (const m of messagesOf(f)) add(f.path, x.jobName, m, x.taskId, 1);
    }
  }
  const out = [...byKey.values()];
  const tests = [...new Set(out.map((f) => f.test))];
  const central = await mapLimit(tests, deps.concurrency ?? 8, async (path) => {
    try {
      return (await deps.fx(["test", path, "--limit", "0"])) as FxTest;
    } catch (e) {
      log(`collect: no central history for ${path}: ${(e as Error).message}`);
      return null;
    }
  });
  const history = new Map<string, FxTest>();
  central.forEach((c, i) => c && history.set(tests[i], c));
  for (const f of out) {
    const h = history.get(f.test);
    if (!h) continue;
    const runs = h.configs.filter((c) => configOf(c.jobName) === f.config);
    if (!runs.length) continue;
    const runCount = runs.reduce((s, c) => s + c.runCount, 0);
    const failCount = runs.reduce((s, c) => s + c.failCount, 0);
    f.runs = runCount;
    f.rate = round((failCount / (h.metadata.dayCount || 1)) * 7);
    f.rateScope = "test";
    f.failPercent = runCount ? round((100 * failCount) / runCount) : 0;
  }
  return out.sort((a, b) => a.test.localeCompare(b.test) || a.config.localeCompare(b.config));
}

// ---------------------------------------------------------------------------
// history

export interface History {
  test: string;
  harness: string;
  window: { start: string; end: string; days: number };
  totals: { runs: number; failures: number; failPercent: number };
  configs: {
    config: string;
    runs: number;
    failures: number;
    failPercent: number;
    recentFailPercent?: number;
    perWeek: number;
    firstSeen?: string;
    lastSeen?: string;
  }[];
  daily: { date: string; runs: number; failures: number }[];
  firstSeen: string | null;
  firstSeenAtWindowStart: boolean;
  trend: "none" | "new" | "rising" | "falling" | "stable";
}

export async function history(test: string, deps: Deps = defaultDeps): Promise<History> {
  const t = (await deps.fx(["test", test, "--history", "--task-ids", "--limit", "0"])) as FxTest;
  return historyFrom(t);
}

export function historyFrom(t: FxTest): History {
  const days = t.metadata.dayCount || 1;
  const seen = new Map<string, { first: string; last: string }>();
  for (const x of t.taskIds ?? []) {
    const k = configOf(x.jobName);
    const s = seen.get(k);
    if (!s) seen.set(k, { first: x.day, last: x.day });
    else {
      if (x.day < s.first) s.first = x.day;
      if (x.day > s.last) s.last = x.day;
    }
  }
  const configs = t.configs
    .map((c) => {
      const config = configOf(c.jobName);
      const s = seen.get(config);
      return {
        config,
        runs: c.runCount,
        failures: c.failCount,
        failPercent: round(c.failRate),
        ...(c.recentFailRate !== undefined ? { recentFailPercent: round(c.recentFailRate) } : {}),
        perWeek: round((c.failCount / days) * 7),
        ...(s ? { firstSeen: s.first, lastSeen: s.last } : {}),
      };
    })
    .sort((a, b) => b.failPercent - a.failPercent);
  const daily = (t.history ?? []).map((d) => {
    const failures = d.fail + d.timeout + d.crash;
    return { date: d.date, runs: d.pass + failures, failures };
  });
  const firstDay = daily.find((d) => d.failures > 0)?.date ?? null;
  const failures = t.totals.failCount + t.totals.timeoutCount + t.totals.crashCount;
  return {
    test: t.path,
    harness: t.harness,
    window: { start: t.metadata.startDate, end: t.metadata.endDate, days },
    totals: { runs: t.totals.runCount, failures, failPercent: t.totals.runCount ? round((100 * failures) / t.totals.runCount) : 0 },
    configs,
    daily,
    firstSeen: firstDay,
    firstSeenAtWindowStart: firstDay !== null && firstDay === daily[0]?.date,
    trend: trendOf(daily),
  };
}

// Last 7 days against the days before, by failure rate (weekends make raw counts misleading).
export function trendOf(daily: { runs: number; failures: number }[]): History["trend"] {
  if (!daily.some((d) => d.failures > 0)) return "none";
  const recent = daily.slice(-7);
  const before = daily.slice(0, -7);
  const rate = (ds: typeof daily) => {
    const runs = ds.reduce((s, d) => s + d.runs, 0);
    return runs ? ds.reduce((s, d) => s + d.failures, 0) / runs : 0;
  };
  if (!before.length) return "stable";
  if (!before.some((d) => d.failures > 0)) return "new";
  const r = rate(recent);
  const b = rate(before);
  if (r > b * 1.5) return "rising";
  if (r < b / 1.5) return "falling";
  return "stable";
}

// ---------------------------------------------------------------------------
// cluster

// Messages that say how a test failed but not why. Two tests sharing one of these are not evidence
// of a shared cause, so they are never grouped across tests. Matched against normalizeMessage().
export const GENERIC_MESSAGES: { pattern: RegExp; why: string }[] = [
  { pattern: /^$/, why: "empty" },
  { pattern: /^\(no message recorded/, why: "fx-tests found no message" },
  { pattern: /^failure details not recorded/, why: "fx-tests found no message" },
  { pattern: /^test timed out\.?( -)?$/, why: "timeout, without what was being waited for" },
  { pattern: /^test exceeded (the )?time limit/, why: "timeout" },
  { pattern: /^this test exceeded the timeout threshold/, why: "slowness warning" },
  { pattern: /^application timed out after <n>( seconds)? with no output/, why: "harness timeout" },
  { pattern: /^application ran for longer than allowed maximum time/, why: "harness timeout" },
  { pattern: /^(application|browser) crashed( \[@ (unknown|<hex>)\])?$/, why: "crash without a signature" },
  { pattern: /^application terminated with exit code/, why: "exit code only" },
  { pattern: /^unexpected pass$/, why: "status only" },
  { pattern: /^found a (tab|browser window) after previous test timed out/, why: "consequence of another test" },
  { pattern: /^(leakcheck \| )?\S* ?(process: )?<n> bytes leaked$/, why: "leak total without the leaked objects" },
  { pattern: /^(leakcheck \| )?missing output line for total leaks/, why: "leak check infrastructure" },
  { pattern: /^unexpected exception undefined\b/, why: "no exception message" },
  { pattern: /^(uncaught exception|uncaught rejection|a promise chain failed to handle a rejection)( -|:)? ?(undefined|null|\[object object\]|\(unable to convert rejection reason to string\.?\))?$/, why: "no reason given" },
  { pattern: /^assertion count <n> is (greater|less) than expected/, why: "count only" },
  { pattern: /^shutdown hang\b|^shutdown timeout\b/, why: "hang without a stack" },
  { pattern: /^\[unknown\]$/, why: "crash without a signature" },
  { pattern: /^@ <?mozglue_static::panic_hook\b/, why: "the frame every Rust panic goes through" },
  {
    pattern: /^\[[\w$.]+ : <n>\] (<n>|true|false|null|undefined|"[^"]*") (==|===|!=|!==|deepequal|>|<|>=|<=) (<n>|true|false|null|undefined|"[^"]*")$/,
    why: "assertion without a description: only the function name says where",
  },
  {
    pattern: /^(\[[\w$.]+ : <n>\] )?((undefined|null) )?- got [^,]*, expected .*$/,
    why: "assertion without a description",
  },
];

// Strips what differs between occurrences of the same failure: numbers, hex ids, uuids, paths,
// timings, pids, ports. Paths keep their file name, which usually says where the failure is.
const SOURCE_FILE = /\.(js|mjs|jsm|sys\.mjs|ts|html|xhtml|py|cpp|cc|c|h|rs)$/;

export function normalizeMessage(message: string): string {
  let m = message.trim();
  m = m.replace(/^TEST-UNEXPECTED-[A-Z]+ \| [^|]+ \| /, "");
  m = m.replace(/\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?/gi, "<uuid>");
  // URLs keep their path, with the port after the host normalized. Unix and Windows paths with at
  // least two components become <path>, except a source file, which keeps its name: it says where
  // the code failed, while other paths (profile dirs, test data) differ between runs.
  m = m.replace(
    /\b((?:file|resource|chrome|moz-extension|https?):\/\/[^\s'"()`]*)|(?<![\w:])(?:[A-Za-z]:)?(?:[\\/][\w.@~+-]+){2,}/gi,
    (match, url: string | undefined) => {
      if (url) return url.replace(/^([a-z-]+:\/\/[^/:]*):\d+/i, "$1:<port>");
      const base = match.split(/[\\/]/).pop() ?? "";
      return SOURCE_FILE.test(base) ? base : "<path>";
    },
  );
  m = m.replace(/\b0x[0-9a-f]+\b/gi, "<hex>");
  m = m.replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi, "<hex>");
  m = m.replace(/\d+(\.\d+)?/g, "<n>");
  m = m.replace(/<n>\s*(ms|s|sec|secs|seconds?|minutes?)\b/g, "<n>");
  m = m.replace(/\s+/g, " ");
  return m.toLowerCase();
}

export function isGeneric(message: string): boolean {
  const n = normalizeMessage(message);
  return GENERIC_MESSAGES.some((g) => g.pattern.test(n));
}

export interface ClusterGroup extends FailureGroup {
  key: string;
}

interface Acc {
  key: string;
  messages: Map<string, number>;
  tests: Set<string>;
  configs: Set<string>;
  taskIds: Set<string>;
  rates: Map<string, number>; // "test\nconfig" → rate
}

function newAcc(key: string): Acc {
  return { key, messages: new Map(), tests: new Set(), configs: new Set(), taskIds: new Set(), rates: new Map() };
}

function addTo(a: Acc, f: CollectedFailure): void {
  a.messages.set(f.message, (a.messages.get(f.message) ?? 0) + (f.count ?? 1));
  a.tests.add(f.test);
  a.configs.add(f.config);
  for (const t of f.taskIds ?? []) a.taskIds.add(t);
  if (f.rate !== undefined) {
    const k = `${f.test}\n${f.config}`;
    const prev = a.rates.get(k) ?? 0;
    // A per-test rate (try push) is the same for every message of one test on one config: count it
    // once. Per-message rates (folder history) add up.
    a.rates.set(k, f.rateScope === "test" ? Math.max(prev, f.rate) : prev + f.rate);
  }
}

function toGroup(a: Acc): ClusterGroup {
  const message = [...a.messages.entries()].sort((x, y) => y[1] - x[1])[0][0];
  return {
    message,
    key: a.key,
    tests: [...a.tests].sort(),
    configs: [...a.configs].sort(),
    ...(a.rates.size ? { ratePerWeek: round([...a.rates.values()].reduce((x, y) => x + y, 0)) } : {}),
    taskIds: [...a.taskIds],
  };
}

export function cluster(failures: CollectedFailure[]): { groups: ClusterGroup[]; singles: ClusterGroup[] } {
  const specific = new Map<string, Acc>();
  const generic = new Map<string, Acc>(); // by test
  for (const f of failures) {
    const key = normalizeMessage(f.message);
    if (GENERIC_MESSAGES.some((g) => g.pattern.test(key))) {
      let a = generic.get(f.test);
      if (!a) generic.set(f.test, (a = newAcc(key)));
      addTo(a, f);
    } else {
      let a = specific.get(key);
      if (!a) specific.set(key, (a = newAcc(key)));
      addTo(a, f);
    }
  }
  const order = (x: ClusterGroup, y: ClusterGroup) =>
    y.tests.length - x.tests.length || (y.ratePerWeek ?? 0) - (x.ratePerWeek ?? 0) || x.key.localeCompare(y.key);
  const singles = [...generic.values()].map((a) => {
    const g = toGroup(a);
    g.key = normalizeMessage(g.message);
    return g;
  });
  return { groups: [...specific.values()].map(toGroup).sort(order), singles: singles.sort(order) };
}

// ---------------------------------------------------------------------------
// try-table

export interface TryRow {
  test: string;
  config: string;
  result: "pass" | "fail" | "not-run";
  failures: string[];
  taskIds: string[];
  passedOnRerun?: boolean;
  passTaskIds?: string[]; // jobs of this config where it passed, e.g. retriggers of an intermittent
}

export interface UnparsedJob {
  taskId: string;
  retryId: number;
  jobName: string;
  config: string;
  result: string;
  reason: string;
}

export interface TryTable {
  rev: string;
  pushId: number;
  project: string;
  complete: boolean;
  pending: number;
  configs: string[];
  rows: TryRow[];
  unparsed: UnparsedJob[];
}

export interface TreeherderJob {
  job_type_name: string;
  state: string; // pending | running | completed
  result: string; // success | testfailed | busted | exception | retry | usercancel | unknown
  task_id: string;
  retry_id: number;
}

const FAILED_RESULTS = new Set(["testfailed", "busted", "exception"]);

export async function treeherderJobs(pushId: number, get: JsonFetcher): Promise<TreeherderJob[]> {
  const jobs: TreeherderJob[] = [];
  let url: string | null = `https://treeherder.mozilla.org/api/jobs/?push_id=${pushId}&count=2000`;
  while (url) {
    const page = (await get(url)) as { results: unknown[][]; job_property_names: string[]; next?: string | null };
    for (const r of page.results) {
      const o: Record<string, unknown> = {};
      page.job_property_names.forEach((n, i) => (o[n] = r[i]));
      jobs.push(o as unknown as TreeherderJob);
    }
    url = page.next ?? null;
  }
  return jobs;
}

export type TaskResult = { ok: true; task: FxTask } | { ok: false; error: string };

export async function tryTable(rev: string, opts: { tests?: string[] } = {}, deps: Deps = defaultDeps): Promise<TryTable> {
  const t = (await deps.fx(["try", rev, "--all-jobs", "--limit", "0", "--task-ids", "--messages"])) as FxTry;
  const jobs = await treeherderJobs(t.pushId, deps.fetchJson);
  const toRead = jobs.filter((j) => j.job_type_name.startsWith("test-") && j.state === "completed" && j.result !== "retry");
  log(`try-table: reading ${toRead.length} test jobs`);
  const results = await mapLimit(toRead, deps.concurrency ?? 8, async (j): Promise<TaskResult> => {
    try {
      return { ok: true, task: (await deps.fx(["task", `${j.task_id}.${j.retry_id}`, "--passed", "--messages", "--limit", "0"])) as FxTask };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
  const tasks = new Map<string, TaskResult>();
  toRead.forEach((j, i) => tasks.set(`${j.task_id}.${j.retry_id}`, results[i]));
  return buildTryTable(t, jobs, tasks, opts.tests ?? []);
}

interface Cell {
  fail: Map<string, Set<string>>; // message → taskIds
  pass: Set<string>;
  passedOnRerun: boolean;
}

export function buildTryTable(t: FxTry, jobs: TreeherderJob[], tasks: Map<string, TaskResult>, extraTests: string[]): TryTable {
  const testJobs = jobs.filter((j) => j.job_type_name.startsWith("test-"));
  const configs = [...new Set(testJobs.map((j) => configOf(j.job_type_name)))].sort();
  const cells = new Map<string, Map<string, Cell>>(); // test → config → cell
  const seenSuites = new Map<string, Set<string>>(); // test → suites it appeared in, any status
  const failing = new Set<string>();
  const cell = (test: string, config: string): Cell => {
    let byConfig = cells.get(test);
    if (!byConfig) cells.set(test, (byConfig = new Map()));
    let c = byConfig.get(config);
    if (!c) byConfig.set(config, (c = { fail: new Map(), pass: new Set(), passedOnRerun: false }));
    return c;
  };
  const sawSuite = (test: string, config: string) => {
    let s = seenSuites.get(test);
    if (!s) seenSuites.set(test, (s = new Set()));
    s.add(suiteOf(config));
  };
  const addFail = (test: string, config: string, messages: string[], taskId: string) => {
    failing.add(test);
    sawSuite(test, config);
    const c = cell(test, config);
    for (const m of messages) {
      let s = c.fail.get(m);
      if (!s) c.fail.set(m, (s = new Set()));
      s.add(taskId);
    }
  };

  const blamed = new Set<string>();
  for (const [, r] of tasks) {
    if (!r.ok) continue;
    const config = configOf(r.task.jobName);
    for (const f of r.task.failures) {
      addFail(f.path, config, messagesOf(f), r.task.taskId);
      if (f.passedOnRerun) cell(f.path, config).passedOnRerun = true;
      blamed.add(`${r.task.taskId}.${r.task.retryId}`);
    }
    for (const p of r.task.passed ?? []) {
      sawSuite(p.path, config);
      if (p.statuses.some((s) => !s.startsWith("SKIP"))) cell(p.path, config).pass.add(r.task.taskId);
    }
  }
  // Only for jobs fx-tests task couldn't read: the push view mixes the messages of every config.
  for (const f of tryFailures(t)) {
    for (const x of f.taskIds ?? []) {
      const id = `${x.taskId}.${x.retryId}`;
      const r = tasks.get(id);
      if (r?.ok) continue;
      addFail(f.path, configOf(x.jobName), messagesOf(f), x.taskId);
      // A job fx-tests task couldn't read stays unparsed: its other tests have no result at all.
      if (!r) blamed.add(id);
    }
  }

  const rows: TryRow[] = [];
  const rowTests = [...new Set([...failing, ...extraTests])].sort();
  for (const test of rowTests) {
    const suites = seenSuites.get(test);
    const relevant = suites ? configs.filter((c) => suites.has(suiteOf(c))) : configs;
    for (const config of relevant) {
      const c = cells.get(test)?.get(config);
      if (c && c.fail.size) {
        const ids = new Set<string>();
        for (const s of c.fail.values()) for (const id of s) ids.add(id);
        rows.push({
          test,
          config,
          result: "fail",
          failures: [...c.fail.keys()],
          taskIds: [...ids],
          ...(c.passedOnRerun ? { passedOnRerun: true } : {}),
          ...(c.pass.size ? { passTaskIds: [...c.pass] } : {}),
        });
      } else if (c && c.pass.size) {
        rows.push({ test, config, result: "pass", failures: [], taskIds: [...c.pass] });
      } else {
        rows.push({ test, config, result: "not-run", failures: [], taskIds: [] });
      }
    }
  }

  const unparsed: UnparsedJob[] = [];
  for (const j of jobs) {
    if (j.state !== "completed") continue;
    const id = `${j.task_id}.${j.retry_id}`;
    const r = tasks.get(id);
    let reason: string;
    if (r && !r.ok) {
      // Green jobs too: none of their tests has a result.
      reason = firstLine(r.error);
    } else if (FAILED_RESULTS.has(j.result) && !blamed.has(id)) {
      reason = j.job_type_name.startsWith("test-") ? "fx-tests attributed no failure to a test in this job" : "not a test job";
    } else {
      continue;
    }
    unparsed.push({ taskId: j.task_id, retryId: j.retry_id, jobName: j.job_type_name, config: configOf(j.job_type_name), result: j.result, reason });
  }

  const pending = jobs.filter((j) => j.state !== "completed").length;
  return { rev: t.revision, pushId: t.pushId, project: t.project, complete: pending === 0, pending, configs, rows, unparsed };
}

function firstLine(s: string): string {
  return s.replace(/^fx-tests .*? exited with \d+: (fx-tests: )?/, "").split("\n")[0];
}

// ---------------------------------------------------------------------------

if (import.meta.main) {
  await runCli(
    {
      collect: async ([target]) => {
        if (!target) throw new UsageError("usage: collect <rev|folder>");
        return collect(target);
      },
      history: async ([test]) => {
        if (!test) throw new UsageError("usage: history <test>");
        return history(test);
      },
      cluster: async ([file]) => {
        if (!file) throw new UsageError("usage: cluster <failures.json|->");
        const text = readFileSync(file === "-" ? 0 : file, "utf8");
        return cluster(JSON.parse(text) as CollectedFailure[]);
      },
      "try-table": async ([rev], values) => {
        if (!rev) throw new UsageError("usage: try-table <rev> [--test <path>]...");
        return tryTable(rev, { tests: (values.test as string[] | undefined) ?? [] });
      },
    },
    { test: { type: "string", multiple: true } },
  );
}
