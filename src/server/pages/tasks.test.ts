import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TryJob } from "../../cli/task-set.ts";
import type { DryRunResult } from "../../cli/try.ts";
import { parseLabel, platformName, pushTasks, rowsOf } from "./tasks.ts";

describe("try jobs as Treeherder shows them", () => {
  it("names machine platforms like Treeherder's thPlatformMap", () => {
    const names: Record<string, string> = {
      linux64: "Linux", "linux64-shippable": "Linux Shippable", "linux2404-64": "Linux 24.04", "linux2404-64-asan": "Linux 24.04 asan",
      "linux2204-64-wayland": "Linux 22.04 Wayland", "osx-cross": "macOS", "osx-cross-aarch64": "macOS AArch64", "macosx1015-64-qr": "macOS 10.15",
      "macosx1470-64-shippable": "macOS 14.70 Shippable", "macosx1500-aarch64-vms-shippable": "macOS 15 AArch64 Shippable VM",
      "windows10-64-2009-qr": "Windows 10 2009", "windows11-32-25h2": "Windows 11 x86 25H2", "windows11-aarch64-25h2": "Windows 11 25H2 AArch64",
      "windows11-64-24h2-hw-ref-shippable": "Windows 11 24H2 Ref HW Shippable", "windows2012-64": "Windows", "windows2012-32": "Windows x86",
      "android-em-14-x86_64-lite": "Android 14.0 x86-64 Lite", toolchains: "Toolchains", solaris: "solaris",
    };
    assert.deepEqual(Object.fromEntries(Object.keys(names).map((p) => [p, platformName(p)])), names);
  });

  it("guesses platform, group and symbol from a label when there is no task set", () => {
    const j = (label: string) => {
      const { platform, collection, group, symbol } = parseLabel(label);
      return [platform, collection, group, symbol].join(" | ");
    };
    assert.equal(j("test-macosx1015-64-qr/debug-xpcshell-3"), "macosx1015-64-qr | debug | X | X3");
    assert.equal(j("test-linux2404-64/debug-xpcshell-nofis-*"), "linux2404-64 | debug | X-nofis | X*");
    assert.equal(j("test-linux2404-64/opt-mochitest-browser-chrome-standalone-2"), "linux2404-64 | opt | M-sa | bc2");
    assert.equal(j("test-windows11-64-25h2/opt-mochitest-plain"), "windows11-64-25h2 | opt | M | 1");
    assert.equal(j("test-linux2404-64/debug-gtest-1proc"), "linux2404-64 | debug |  | GTest-1proc");
    assert.equal(j("build-linux64-shippable/opt"), "linux64-shippable | opt |  | B");
    assert.equal(j("source-test-mozlint-eslint"), "other | opt |  | source-test-mozlint-eslint");
  });

  it("orders rows like Treeherder: by OS, builds first except on Windows, then opt, asan, debug; ungrouped jobs first", () => {
    const job = (platform: string, collection: string, group = "", tier = 1): TryJob => ({ label: `${platform}/${collection}-${group}`, platform, collection, group, symbol: "1", tier });
    const rows = rowsOf([
      job("windows11-64-25h2", "debug", "X"), job("windows2012-64", "debug"), job("linux2404-64", "debug", "X"), job("linux2404-64", "opt", "X"),
      job("linux64", "asan"), job("linux64", "debug"), job("osx-cross", "debug"), job("macosx1500-aarch64", "debug", "X"), job("linux2404-64", "debug", "X-nofis", 2), job("linux2404-64", "debug"),
    ]);
    assert.deepEqual(rows.map((r) => `${r.name} ${r.collection}`), [
      "Linux asan", "Linux debug", "Linux 24.04 opt", "Linux 24.04 debug", "macOS debug", "macOS 15 AArch64 debug", "Windows 11 25H2 debug", "Windows debug",
    ]);
    assert.deepEqual(rows[3].groups.map((g) => `${g.symbol}/${g.tier}`), ["/1", "X/1", "X-nofis/2"]);
  });
});

describe("pushTasks", () => {
  const dry = (tryTaskConfig: Record<string, unknown>, jobs?: TryJob[], tasks: string[] = []): DryRunResult => ({ command: ["./mach", "try", "fuzzy"], tasks, taskCount: 1, tryTaskConfig, commits: [], warnings: [], ...(jobs ? { jobs } : {}) });
  const X1: TryJob = { label: "test-linux2404-64/debug-xpcshell-1", platform: "linux2404-64", collection: "debug", group: "X", symbol: "X1", tier: 1, build: "build-linux64/debug" };
  const NOFIS: TryJob = { ...X1, label: "test-linux2404-64/debug-xpcshell-nofis-1", group: "X-nofis", tier: 2 };
  const B: TryJob = { label: "build-linux64/debug", platform: "linux64", collection: "debug", group: "", symbol: "B", tier: 1, artifact: true };
  const BO: TryJob = { label: "build-linux64-asan/opt", platform: "linux64", collection: "asan", group: "", symbol: "Bo", tier: 1 };
  const ASAN: TryJob = { ...X1, label: "test-linux2404-64-asan/opt-xpcshell", platform: "linux2404-64-asan", collection: "opt", symbol: "X", build: BO.label };

  it("shows each run of a job, its build once, artifact builds as Ba, tiers above 1", () => {
    const h = pushTasks(dry({ "use-artifact-builds": true, rebuild: 3 }, [X1, B, NOFIS, ASAN, BO])).value;
    const s = (title: string, symbol: string) => `<span class="job" title="${title}">${symbol}</span>`;
    const x1 = s(X1.label, "X1");
    assert.ok(h.includes(`<tr><th>Linux <span class="btype">asan</span></th><td>${s(BO.label, "Bo")}</td></tr>`), h);
    assert.ok(h.includes(`<tr><th>Linux <span class="btype">debug</span></th><td>${s(`${B.label} (artifact build)`, "Ba")}</td></tr>`), h);
    const nofis = s(NOFIS.label, "X1");
    assert.ok(h.includes(`<tr><th>Linux 24.04 <span class="btype">debug</span></th><td><span class="jgroup">X( ${x1} ${x1} ${x1} )</span> <span class="jgroup"><span class="tier">[tier 2]</span>X-nofis( ${nofis} ${nofis} ${nofis} )</span></td></tr>`), h);
    assert.match(h, /^<div class="pfolders"><b>All the tests<\/b> of the selected suites<\/div><ul class="pcommits"/, "what it runs, then its commits, the top of the stack shown");
    assert.match(h, /<\/table>\n<details class="fold"><summary>Its command and try_task_config\.json<\/summary><pre class="mono command">\.\/mach try fuzzy<\/pre>\n<pre class="mono ttc"[^>]*>\{\n  &quot;use-artifact-builds&quot;: true,/, "the jobs, then the command and its try_task_config, folded");
  });

  it("runs builds once and full builds as B; a per-label rebuild may name the chunk pattern", () => {
    const h = pushTasks(dry({ rebuild: { "test-linux2404-64/debug-xpcshell-*": 2 } }, [X1, B])).value;
    assert.match(h, /<td><span class="job" title="build-linux64\/debug">B<\/span><\/td>/);
    assert.match(h, /X\( (<span class="job"[^>]*>X1<\/span> ){2}\)/);
  });

  it("falls back to the labels without jobs", () => {
    const h = pushTasks(dry({}, undefined, ["test-linux2404-64/debug-xpcshell-*", "toolchain-thing"])).value;
    assert.match(h, /<th>Linux 24\.04 <span class="btype">debug<\/span><\/th><td><span class="jgroup">X\( <span class="job" title="test-linux2404-64\/debug-xpcshell-\*">X\*<\/span> \)/);
    assert.match(h, /<th>Other <span class="btype">opt<\/span><\/th><td><span class="job" title="toolchain-thing">toolchain-thing<\/span><\/td>/);
  });
});

it("a push's folders show, from mach try's test paths", () => {
  const h = pushTasks({ command: ["./mach", "try"], taskCount: 1, tasks: [], commits: [], warnings: [], tryTaskConfig: { env: { MOZHARNESS_TEST_PATHS: JSON.stringify({ "mochitest-chrome": ["layout/xul/test", "toolkit/content/tests/chrome"], "mochitest-browser-chrome": ["layout/xul/test"] }) } } } as never).value;
  assert.match(h, /<div class="pfolders"><b>2 folders<\/b>: <span class="mono">layout\/xul\/test<\/span>, <span class="mono">toolkit\/content\/tests\/chrome<\/span><\/div>/);
});
