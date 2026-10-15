import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildTryTable,
  cluster,
  collect,
  configOf,
  GENERIC_MESSAGES,
  history,
  isGeneric,
  MAX_TASK_IDS,
  normalizeMessage,
  suiteOf,
  trendOf,
  tryTable,
  type CollectedFailure,
  type Deps,
  type TaskResult,
  type TreeherderJob,
  type TryRow,
} from "./failures.ts";

const FIXTURES = new URL("../../test/fixtures/failures/", import.meta.url);
const load = (name: string) => JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"));

interface TryCapture {
  try: any;
  jobs: { results: unknown[][]; job_property_names: string[] };
  tasks: Record<string, TaskResult>;
}

// Serves captured fx-tests and Treeherder output in place of the real tools.
function deps(capture: Partial<TryCapture>, tests: Record<string, unknown> = {}, flaky?: unknown): Deps {
  return {
    concurrency: 4,
    fx: async (args) => {
      const [cmd, arg] = args;
      if (cmd === "try") return capture.try;
      if (cmd === "task") {
        const r = capture.tasks?.[arg];
        if (!r) throw new Error(`no fixture for task ${arg}`);
        if (!r.ok) throw new Error(r.error);
        return r.task;
      }
      if (cmd === "test") {
        if (!tests[arg]) throw new Error(`fx-tests: no such test ${arg}`);
        return tests[arg];
      }
      if (cmd === "flaky") return flaky;
      throw new Error(`unexpected fx-tests ${args.join(" ")}`);
    },
    fetchJson: async (url) => {
      assert.match(url, new RegExp(`push_id=${capture.try.pushId}\\b`));
      return capture.jobs;
    },
  };
}

function jobsOf(capture: TryCapture): TreeherderJob[] {
  return capture.jobs.results.map((r) => {
    const o: Record<string, unknown> = {};
    capture.jobs.job_property_names.forEach((n, i) => (o[n] = r[i]));
    return o as unknown as TreeherderJob;
  });
}

test("configOf strips the chunk number only", () => {
  assert.equal(configOf("test-android-em-14-x86_64/opt-geckoview-xpcshell-2"), "test-android-em-14-x86_64/opt-geckoview-xpcshell");
  assert.equal(configOf("test-windows11-64-25h2/opt-xpcshell"), "test-windows11-64-25h2/opt-xpcshell");
  assert.equal(configOf("test-linux2404-64-tsan/opt-mochitest-browser-a11y-1"), "test-linux2404-64-tsan/opt-mochitest-browser-a11y");
  assert.equal(suiteOf("test-linux2404-64-asan/opt-mochitest-browser-a11y"), "mochitest-browser-a11y");
  assert.equal(suiteOf("test-windows11-64-25h2/debug-xpcshell"), "xpcshell");
});

// ---------------------------------------------------------------------------
// try-table

test("try-table: xpcshell push on 4 platforms (b0e7e1700424)", async () => {
  const capture: TryCapture = load("try-b0e7e1700424.json");
  const t = await tryTable("b0e7e1700424", {}, deps(capture));
  assert.equal(t.complete, true);
  assert.equal(t.pending, 0);
  assert.deepEqual(t.configs, [
    "test-android-em-14-x86_64/opt-geckoview-xpcshell",
    "test-linux2404-64/opt-xpcshell",
    "test-macosx1500-aarch64/opt-xpcshell",
    "test-windows11-64-25h2/opt-xpcshell",
  ]);
  assert.deepEqual(t.unparsed, []);

  const cells = (path: string) => Object.fromEntries(t.rows.filter((r) => r.test === path).map((r) => [r.config.split("/")[0], r]));
  const enc = cells("intl/uconv/tests/unit/test_encode_8859-4.js");
  assert.equal(enc["test-android-em-14-x86_64"].result, "fail");
  assert.equal(enc["test-android-em-14-x86_64"].passedOnRerun, true);
  assert.deepEqual(enc["test-android-em-14-x86_64"].failures, ["(no message recorded, status FAIL)"]);
  for (const p of ["test-linux2404-64", "test-macosx1500-aarch64", "test-windows11-64-25h2"]) assert.equal(enc[p].result, "pass");

  const dmd = cells("memory/replace/dmd/test/test_dmd.js");
  for (const p of ["test-linux2404-64", "test-macosx1500-aarch64", "test-windows11-64-25h2"]) {
    assert.equal(dmd[p].result, "fail");
    assert.match(dmd[p].failures[0], /^wrote to its test directory/);
  }

  // Every failure fx-tests saw in a job is a "fail" cell on that job's config.
  for (const r of Object.values(capture.tasks)) {
    if (!r.ok) continue;
    for (const f of r.task.failures) {
      const row: TryRow | undefined = t.rows.find((x) => x.test === f.path && x.config === configOf(r.task.jobName));
      assert.equal(row?.result, "fail", `${f.path} on ${r.task.jobName}`);
      assert.ok(row.taskIds.includes(r.task.taskId));
    }
  }
  // A "pass" is backed by a job where the test ran and wasn't skipped.
  for (const row of t.rows.filter((x) => x.result === "pass")) {
    assert.ok(row.taskIds.length > 0);
    const ran = Object.values(capture.tasks).some(
      (r) => r.ok && configOf(r.task.jobName) === row.config && r.task.passed?.some((p) => p.path === row.test && p.statuses.some((s) => s !== "SKIP")),
    );
    assert.ok(ran, `${row.test} on ${row.config}`);
  }
});

test("try-table: a test in a job that hasn't finished is not-run, never pass", async () => {
  const capture: TryCapture = load("try-b0e7e1700424.json");
  const linux = "RZLa8YCLTly4eYhOPFYYyA";
  const stateIdx = capture.jobs.job_property_names.indexOf("state");
  const taskIdx = capture.jobs.job_property_names.indexOf("task_id");
  for (const r of capture.jobs.results) if (r[taskIdx] === linux) r[stateIdx] = "running";
  delete capture.tasks[`${linux}.0`];
  // fx-tests' push view only knows about finished jobs.
  for (const k of ["permaFails", "knownIntermittents", "newIntermittents"]) {
    for (const f of capture.try[k]) f.taskIds = f.taskIds.filter((x: { taskId: string }) => x.taskId !== linux);
  }
  const t = await tryTable("b0e7e1700424", {}, deps(capture));
  assert.equal(t.complete, false);
  assert.equal(t.pending, 1);
  const row = t.rows.find((r) => r.test === "intl/uconv/tests/unit/test_encode_8859-4.js" && r.config === "test-linux2404-64/opt-xpcshell");
  assert.equal(row?.result, "not-run");
});

test("try-table: --test for a test that ran nowhere gives not-run on every config", async () => {
  const capture: TryCapture = load("try-b0e7e1700424.json");
  const t = await tryTable("b0e7e1700424", { tests: ["dom/nothing/test_absent.js"] }, deps(capture));
  const rows = t.rows.filter((r) => r.test === "dom/nothing/test_absent.js");
  assert.equal(rows.length, t.configs.length);
  assert.ok(rows.every((r) => r.result === "not-run" && r.taskIds.length === 0));
});

test("try-table: mochitest push with jobs killed for max run time (fbbe37af13b3)", async () => {
  const capture: TryCapture = load("try-fbbe37af13b3.json");
  const t = await tryTable("fbbe37af13b3", {}, deps(capture));
  assert.equal(t.complete, true);
  // The two killed jobs fx-tests can't read, and not the retried build.
  assert.deepEqual(t.unparsed.map((u) => u.taskId).sort(), ["Do_7U5hER1CKVh7MnBDMcA", "W8chfSVORciMO2kjORWUSA"]);
  for (const u of t.unparsed) {
    assert.equal(u.config, "test-linux2204-64-wayland/debug-mochitest-browser-a11y");
    assert.equal(u.result, "testfailed");
    assert.match(u.reason, /killed for exceeding its maximum duration/);
  }

  const notif = Object.fromEntries(t.rows.filter((r) => r.test === "accessible/tests/browser/atk/browser_notification.js").map((r) => [r.config, r]));
  assert.equal(notif["test-linux2204-64-wayland/opt-mochitest-browser-a11y"].result, "fail");
  assert.equal(notif["test-linux2204-64-wayland/opt-mochitest-browser-a11y"].taskIds.length, 3);
  assert.equal(notif["test-linux2204-64-wayland/debug-mochitest-browser-a11y"].result, "fail");
  assert.equal(notif["test-linux2404-64/opt-mochitest-browser-a11y"].result, "pass");
  // A linux-only test: no execution on mac, which must not read as a pass.
  assert.equal(notif["test-macosx1500-aarch64/opt-mochitest-browser-a11y"].result, "not-run");

  // Skipped by its manifest on linux: not-run there.
  const scroll = t.rows.find((r) => r.test === "accessible/tests/browser/scroll/browser_test_scroll_bounds.js" && r.config === "test-linux2404-64/opt-mochitest-browser-a11y");
  assert.equal(scroll?.result, "not-run");
});

test("buildTryTable: a failed job with no test failure is unparsed", () => {
  const capture: TryCapture = load("try-b0e7e1700424.json");
  const jobs = jobsOf(capture);
  const tasks = new Map(Object.entries(capture.tasks));
  const android = "HdfZH6_BTgWPiHJkv4ntMg.0";
  const r = tasks.get(android);
  assert.ok(r?.ok);
  tasks.set(android, { ok: true, task: { ...r.task, failures: [] } });
  const tryOut = structuredClone(capture.try);
  for (const k of ["permaFails", "knownIntermittents", "newIntermittents"]) {
    for (const f of tryOut[k]) f.taskIds = f.taskIds.filter((x: { taskId: string }) => x.taskId !== "HdfZH6_BTgWPiHJkv4ntMg");
  }
  const t = buildTryTable(tryOut, jobs, tasks, []);
  assert.deepEqual(t.unparsed, [
    {
      taskId: "HdfZH6_BTgWPiHJkv4ntMg",
      retryId: 0,
      jobName: "test-android-em-14-x86_64/opt-geckoview-xpcshell-2",
      config: "test-android-em-14-x86_64/opt-geckoview-xpcshell",
      result: "testfailed",
      reason: "fx-tests attributed no failure to a test in this job",
    },
  ]);
});

test("try-table: a job fx-tests can't read falls back to the push view and stays unparsed", async () => {
  const capture: TryCapture = load("try-b0e7e1700424.json");
  const linux = "RZLa8YCLTly4eYhOPFYYyA";
  capture.tasks[`${linux}.0`] = { ok: false, error: "fx-tests task RZLa8YCLTly4eYhOPFYYyA.0 --json --quiet exited with 3: fx-tests: upstream unavailable" };
  const t = await tryTable("b0e7e1700424", {}, deps(capture));
  const cell = (test: string) => t.rows.find((r) => r.test === test && r.config === "test-linux2404-64/opt-xpcshell");
  // Blamed by the push view: still a failure.
  assert.equal(cell("memory/replace/dmd/test/test_dmd.js")?.result, "fail");
  // Its other tests have no result: not-run, and the job is listed.
  assert.equal(cell("intl/uconv/tests/unit/test_encode_8859-4.js")?.result, "not-run");
  assert.deepEqual(t.unparsed, [
    { taskId: linux, retryId: 0, jobName: "test-linux2404-64/opt-xpcshell", config: "test-linux2404-64/opt-xpcshell", result: "testfailed", reason: "upstream unavailable" },
  ]);
});

test("try-table: a green job fx-tests can't read is unparsed too", async () => {
  const capture: TryCapture = load("try-b0e7e1700424.json");
  capture.tasks["aLDCVvafRYuahrJawvWhZg.0"] = { ok: false, error: "fx-tests: profile expired" };
  const t = await tryTable("b0e7e1700424", {}, deps(capture));
  assert.deepEqual(
    t.unparsed.map((u) => [u.taskId, u.retryId, u.result]),
    [["aLDCVvafRYuahrJawvWhZg", 0, "success"]],
  );
});

test("try-table: a run with result retry is ignored in favour of its rerun", async () => {
  const capture: TryCapture = load("try-b0e7e1700424.json");
  const names = capture.jobs.job_property_names;
  const [taskIdx, retryIdx, resultIdx] = ["task_id", "retry_id", "result"].map((n) => names.indexOf(n));
  const linux = "RZLa8YCLTly4eYhOPFYYyA";
  const row = capture.jobs.results.find((r) => r[taskIdx] === linux)!;
  const retried = [...row];
  retried[resultIdx] = "retry";
  row[retryIdx] = 1;
  capture.jobs.results.push(retried);
  const r = capture.tasks[`${linux}.0`];
  assert.ok(r.ok);
  delete capture.tasks[`${linux}.0`]; // reading run 0 would throw in deps()
  capture.tasks[`${linux}.1`] = { ok: true, task: { ...r.task, retryId: 1 } };
  const before = await tryTable("b0e7e1700424", {}, deps(load("try-b0e7e1700424.json")));
  const t = await tryTable("b0e7e1700424", {}, deps(capture));
  assert.deepEqual(t.unparsed, []);
  assert.deepEqual(t.rows, before.rows);
});

test("try-table: a failure with passing retriggers lists them", async () => {
  const capture: TryCapture = load("try-fbbe37af13b3.json");
  const t = await tryTable("fbbe37af13b3", {}, deps(capture));
  const row = t.rows.find(
    (r) => r.test === "accessible/tests/browser/bounds/browser_test_simple_transform.js" && r.config === "test-macosx1500-aarch64/debug-mochitest-browser-a11y",
  );
  assert.equal(row?.result, "fail");
  assert.ok(row.passTaskIds && row.passTaskIds.length >= 1);
  assert.ok(row.passTaskIds.every((id) => !row.taskIds.includes(id) || row.passedOnRerun));
});

// ---------------------------------------------------------------------------
// collect

test("collect <rev>: per (test, config, message), with central rates (27999ea83b92)", async () => {
  const capture: TryCapture = load("try-27999ea83b92.json");
  const out = await collect("27999ea83b92", deps(capture, load("central-27999ea83b92.json")));
  assert.ok(out.length >= 12);
  assert.ok(out.every((f) => f.config === "test-linux2404-64/opt-xpcshell" && f.taskIds.includes("LvdsGq94QtavBauTsprKIg")));
  const pkcs = out.find((f) => f.test === "security/manager/ssl/tests/unit/test_pkcs11_module_client_auth.js");
  assert.equal(pkcs?.message, "Test timed out");
  assert.equal(pkcs?.runs, 319);
  assert.equal(pkcs?.rate, Math.round((2 / 21) * 7 * 100) / 100);
  // No history on this config: no rate rather than a zero.
  const bookmarks = out.find((f) => f.test === "browser/components/migration/tests/unit/test_Chrome_bookmarks.js");
  assert.ok(bookmarks);
  assert.equal(bookmarks.rate, undefined);
});

test("collect <folder>: central history of each failing test", async () => {
  const folder = load("folder-places.json");
  const out = await collect(folder.folder, deps({}, folder.tests, folder.flaky));
  const tests = new Set(out.map((f) => f.test));
  assert.equal(tests.size, 3);
  for (const f of out) {
    assert.ok(f.taskIds.length > 0 && f.taskIds.length <= MAX_TASK_IDS);
    assert.equal(f.rate, Math.round((f.count / 21) * 7 * 100) / 100);
    assert.ok(f.message.length > 0);
  }
  // A null message from fx-tests gets a placeholder from its status.
  assert.ok(out.some((f) => f.message === "Test timed out"));
});

// ---------------------------------------------------------------------------
// history

test("history: per-config rates, first seen and trend", async () => {
  const fixture = load("history-test_async_transactions.json");
  const h = await history(fixture.path, deps({}, { [fixture.path]: fixture }));
  assert.equal(h.test, "toolkit/components/places/tests/unit/test_async_transactions.js");
  assert.equal(h.window.days, 21);
  assert.equal(h.daily.length, 21);
  assert.equal(h.configs[0].config, "test-windows11-32-25h2/debug-xpcshell");
  assert.ok(h.configs.every((c, i) => i === 0 || c.failPercent <= h.configs[i - 1].failPercent));
  assert.equal(h.firstSeen, "2026-09-24");
  assert.equal(h.firstSeenAtWindowStart, true);
  assert.equal(h.trend, "stable");
  assert.ok(h.configs[0].firstSeen && h.configs[0].lastSeen);
});

test("trendOf", () => {
  const days = (before: number, recent: number) => [
    ...Array.from({ length: 14 }, () => ({ runs: 100, failures: before })),
    ...Array.from({ length: 7 }, () => ({ runs: 100, failures: recent })),
  ];
  assert.equal(trendOf(days(0, 0)), "none");
  assert.equal(trendOf(days(0, 3)), "new");
  assert.equal(trendOf(days(2, 6)), "rising");
  assert.equal(trendOf(days(6, 2)), "falling");
  assert.equal(trendOf(days(5, 5)), "stable");
});

// ---------------------------------------------------------------------------
// cluster

test("normalizeMessage strips numbers, hex, uuids, paths, timings, pids and ports", () => {
  assert.equal(normalizeMessage("[test_ODA : 40] 65 == 66"), normalizeMessage("[test_ODA : 41] 1 == 2"));
  assert.equal(
    normalizeMessage("TypeError: can't convert symbol to string at /builds/worker/workspace/build/tests/xpcshell/head.js:996"),
    normalizeMessage("TypeError: can't convert symbol to string at /opt/worker/tasks/cltbld/build/tests/xpcshell/head.js:998"),
  );
  assert.equal(
    normalizeMessage("Failed at C:\\tasks\\task_1791\\build\\tests\\head.js:12"),
    normalizeMessage("Failed at /builds/worker/tests/head.js:13"),
  );
  assert.equal(normalizeMessage("NS_ERROR_FAILURE 0x80004005 in {12345678-1234-1234-1234-123456789abc}"), "ns_error_failure <hex> in <uuid>");
  assert.equal(normalizeMessage("Connection to http://localhost:49152/foo refused after 1500ms"), normalizeMessage("Connection to http://localhost:8080/foo refused after 3 s"));
  assert.equal(normalizeMessage("[Parent 1234, Main Thread] WARNING"), normalizeMessage("[Parent 98, Main Thread] WARNING"));
  assert.equal(normalizeMessage("Failed to load URL: 804b0014"), "failed to load url: <hex>");
  // Only the port after a host; line and column numbers stay part of the URL.
  assert.equal(
    normalizeMessage("error at resource://testing-common/sinon-7.2.7.js:1234:56"),
    "error at resource://testing-common/sinon-<n>.<n>.js:<n>:<n>",
  );
  assert.equal(normalizeMessage("GET http://127.0.0.1:8888/tests/dom/a/b.html failed"), "get http://<n>.<n>:<port>/tests/dom/a/b.html failed");
});

test("generic messages", () => {
  for (const m of [
    "Test timed out",
    "Test exceeded time limit",
    "application crashed",
    "application crashed [@ unknown]",
    "application timed out after 370 seconds with no output",
    "leakcheck | default process: 2048 bytes leaked",
    "Unexpected exception undefined - timed out after 50 tries.",
    "uncaught rejection: (Unable to convert rejection reason to string.)",
    "(no message recorded, status FAIL)",
    "[run_test : 11] false == true",
    "[test : 322] 6 == 9",
    " - Got 2, expected 3",
    "undefined - Got 2, expected 3",
    "uncaught exception: [object Object]",
    "Test timed out.",
    "",
  ]) {
    assert.ok(isGeneric(m), m);
  }
  for (const m of [
    "application crashed [@ mozilla::dom::Foo::Bar]",
    "leakcheck | default process: 2048 bytes leaked (nsThread, nsTimerImpl)",
    'uncaught rejection: Phase "profile-before-change" is finished, it is too late to register completion',
    "[test_menu_onInstalled : 42] stored menus size - 3 == 0",
    "TypeError: can't convert symbol to string at /builds/worker/head.js:996",
    "Number of tabs - Got 2, expected 3",
    "Test timed out waiting for the popup to open",
  ]) {
    assert.ok(!isGeneric(m), m);
  }
  assert.ok(GENERIC_MESSAGES.every((g) => g.why.length > 0));
});

test("cluster groups specific messages across tests, never generic ones", () => {
  const f = (test: string, config: string, message: string, rate?: number): CollectedFailure => ({
    test,
    config,
    message,
    taskIds: [`${test}-${config}`],
    count: 1,
    ...(rate !== undefined ? { rate } : {}),
  });
  const { groups, singles } = cluster([
    f("a/test_a.js", "linux/opt-xpcshell", "TypeError: can't convert symbol to string at /builds/a/head.js:996", 2),
    f("a/test_a.js", "mac/opt-xpcshell", "TypeError: can't convert symbol to string at /Users/b/head.js:998", 1),
    f("b/test_b.js", "linux/opt-xpcshell", "TypeError: can't convert symbol to string at /builds/c/head.js:1001", 3),
    f("a/test_a.js", "win/opt-xpcshell", "Test timed out", 4),
    f("b/test_b.js", "win/opt-xpcshell", "Test timed out", 5),
    f("b/test_b.js", "mac/opt-xpcshell", "application crashed", 1),
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].tests, ["a/test_a.js", "b/test_b.js"]);
  assert.deepEqual(groups[0].configs, ["linux/opt-xpcshell", "mac/opt-xpcshell"]);
  assert.equal(groups[0].ratePerWeek, 6);
  assert.equal(groups[0].taskIds?.length, 3);
  assert.equal(singles.length, 2);
  assert.ok(singles.every((s) => s.tests.length === 1));
  const b = singles.find((s) => s.tests[0] === "b/test_b.js");
  assert.deepEqual(b?.configs, ["mac/opt-xpcshell", "win/opt-xpcshell"]);
  assert.equal(b?.ratePerWeek, 6);
});

test("cluster: a per-test rate counts once per config, per-message rates add up", () => {
  const perTest = cluster([
    { test: "t.js", config: "c", message: "[f : 1] Got 3 items", taskIds: ["x"], count: 1, rate: 5, rateScope: "test" },
    { test: "t.js", config: "c", message: "[f : 2] Got 4 items", taskIds: ["y"], count: 1, rate: 5, rateScope: "test" },
  ]);
  assert.equal(perTest.groups.length, 1);
  assert.equal(perTest.groups[0].ratePerWeek, 5);
  const perMessage = cluster([
    { test: "t.js", config: "c", message: "[f : 1] Got 3 items", taskIds: ["x"], count: 1, rate: 5, rateScope: "message" },
    { test: "t.js", config: "c", message: "[f : 2] Got 4 items", taskIds: ["y"], count: 1, rate: 2, rateScope: "message" },
  ]);
  assert.equal(perMessage.groups[0].ratePerWeek, 7);
});

test("cluster: messages differing only by a number group together", () => {
  // Deliberately coarse: merge-clusters.md reviews the groups, and can split this one.
  const { groups } = cluster([
    { test: "a.js", config: "c", message: "Request failed with status code: 404", taskIds: ["x"], count: 1 },
    { test: "b.js", config: "c", message: "Request failed with status code: 500", taskIds: ["y"], count: 1 },
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].tests, ["a.js", "b.js"]);
});

test("cluster on a real push groups the migration tests' shared failure", async () => {
  const capture: TryCapture = load("try-27999ea83b92.json");
  const failures = await collect("27999ea83b92", deps(capture, load("central-27999ea83b92.json")));
  const { groups, singles } = cluster(failures);
  const shared = groups.find((g) => g.key.startsWith("unexpected exception unknownerror: could not create directory"));
  assert.ok(shared, groups.map((g) => g.key).join("\n"));
  assert.ok(shared.tests.length >= 2);
  // Timeouts stay one group per test.
  const timeouts = singles.filter((s) => s.key === "test timed out");
  assert.equal(new Set(timeouts.map((s) => s.tests[0])).size, timeouts.length);
  assert.ok(timeouts.length >= 3);
  // Every failure ends up in exactly one place.
  const placed = new Set<string>();
  for (const g of [...groups, ...singles]) for (const t of g.tests) placed.add(t);
  assert.deepEqual([...placed].sort(), [...new Set(failures.map((f) => f.test))].sort());
});
