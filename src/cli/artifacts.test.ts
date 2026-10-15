import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  artifactMarkerFilenames,
  fetchArtifacts,
  kindOf,
  listArtifacts,
  QUEUE,
  selectArtifacts,
  type Artifact,
  type Fetch,
} from "./artifacts.ts";

const FIXTURES = new URL("../../test/fixtures/artifacts/", import.meta.url);
const text = (name: string) => readFileSync(new URL(name, FIXTURES), "utf8");
const json = (name: string) => JSON.parse(text(name));

const RZLA = "RZLa8YCLTly4eYhOPFYYyA";

// A fake Taskcluster queue: JSON endpoints from `routes` (the task status from the fixture unless
// given), artifact downloads from `files[run]`.
function fakeQueue(taskId: string, routes: Record<string, unknown>, files: Record<number, Record<string, string>>) {
  const requests: string[] = [];
  const all: Record<string, unknown> = { [`${QUEUE}/task/${taskId}/status`]: json(`status-${RZLA}.json`), ...routes };
  const download = new RegExp(`^${QUEUE}/task/${taskId}/runs/(\\d+)/artifacts/(.+)$`);
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url in all) return Response.json(all[url]);
    const m = download.exec(url);
    if (m) {
      const content = files[Number(m[1])]?.[decodeURIComponent(m[2])];
      return content === undefined ? new Response("not found", { status: 404 }) : new Response(content);
    }
    return new Response("unexpected", { status: 500 });
  }) as Fetch;
  return { fetchImpl, requests };
}

function withRunStates(states: string[]) {
  const s = json(`status-${RZLA}.json`);
  s.status.runs = states.map((state, runId) => ({ ...s.status.runs[0], runId, state }));
  return { [`${QUEUE}/task/${RZLA}/status`]: s };
}

function rzlaFiles(listing: Artifact[], run = 0): Record<string, string> {
  const files: Record<string, string> = {};
  for (const a of listing) files[a.name] = `run ${run}: ${a.name}`;
  files["public/test_info/profile_resource-usage.json"] = text(`resource-usage-${RZLA}.json`);
  return files;
}

test("kindOf", () => {
  assert.equal(kindOf("public/logs/live_backing.log"), "log");
  assert.equal(kindOf("public/logs/live.log"), null);
  assert.equal(kindOf("public/test_info/xpcshell_errorsummary.log"), "errorsummary");
  assert.equal(kindOf("public/test_info/mochitest-browser-a11y_errorsummary.log"), "errorsummary");
  assert.equal(kindOf("public/test_info/profile_resource-usage.json"), "resource-profile");
  assert.equal(kindOf("public/test_info/profile_browser_notification-2.js.json.gz"), "test-profile");
  assert.equal(kindOf("public/test_info/profile_test_async_transactions.js.json.gz"), "test-profile");
  assert.equal(kindOf("public/test_info/perfherder-data-resource-usage.json"), null);
  assert.equal(kindOf("public/test_info/summary.jsonl"), null);
});

test("selectArtifacts on a mochitest job with retry profiles", () => {
  const { artifacts } = json("list-W8chfSVORciMO2kjORWUSA.json");
  assert.deepEqual(selectArtifacts(artifacts), [
    { name: "public/logs/live_backing.log", kind: "log" },
    { name: "public/test_info/mochitest-browser-a11y_errorsummary.log", kind: "errorsummary" },
    { name: "public/test_info/profile_browser_announcement-2.js.json.gz", kind: "test-profile" },
    { name: "public/test_info/profile_browser_announcement.js.json.gz", kind: "test-profile" },
    { name: "public/test_info/profile_browser_notification-2.js.json.gz", kind: "test-profile" },
    { name: "public/test_info/profile_browser_notification.js.json.gz", kind: "test-profile" },
    { name: "public/test_info/profile_resource-usage.json", kind: "resource-profile" },
  ]);
});

test("artifactMarkerFilenames reads both profile formats", () => {
  assert.deepEqual(artifactMarkerFilenames(text(`resource-usage-${RZLA}.json`)).sort(), [
    "profile_resource-usage.json",
    "profile_test_async_transactions.js.json.gz",
    "profile_test_command_line_handler.js.json.gz",
    "profile_test_permmanager_migrate_7-8.js.json.gz",
    "profile_test_quicksuggest_yelp.js.json.gz",
    "summary.jsonl",
    "system-info.log",
    "xpcshell_errorsummary.log",
  ]);
  // A killed job's streamed profile: no Artifact marker was written before the kill.
  const streamed = text("resource-usage-streamed-W8chfSVORciMO2kjORWUSA.jsonl");
  assert.deepEqual(artifactMarkerFilenames(streamed), []);
  const withMarker =
    streamed + '{"type":"marker","name":"artifact","startTime":1,"endTime":null,"data":{"type":"Artifact","filename":"profile_x.js.json.gz","size":3}}\n{"type":"mar';
  assert.deepEqual(artifactMarkerFilenames(withMarker), ["profile_x.js.json.gz"]);
});

test("listArtifacts follows continuation tokens", async () => {
  const { artifacts } = json(`list-${RZLA}.json`);
  const base = `${QUEUE}/task/${RZLA}/runs/0/artifacts`;
  const { fetchImpl } = fakeQueue(RZLA, {
    [base]: { artifacts: artifacts.slice(0, 5), continuationToken: "a b" },
    [`${base}?continuationToken=a%20b`]: { artifacts: artifacts.slice(5) },
  }, {});
  assert.deepEqual(await listArtifacts(RZLA, 0, fetchImpl), artifacts);
});

const LISTING_URL = (run: number) => `${QUEUE}/task/${RZLA}/runs/${run}/artifacts`;

async function inTmp(fn: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "artifacts-test-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("fetchArtifacts downloads what's needed, then skips it the second time", () =>
  inTmp(async (dir) => {
    const listing = json(`list-${RZLA}.json`);
    const { fetchImpl, requests } = fakeQueue(RZLA, { [LISTING_URL(0)]: listing }, { 0: rzlaFiles(listing.artifacts) });
    const r = await fetchArtifacts(RZLA, { into: dir, fetchImpl });
    assert.equal(r.run, 0);
    assert.equal(r.state, "failed");
    assert.deepEqual(r.missing, []);
    assert.deepEqual(r.files.map((f) => [f.kind, f.name]), [
      ["resource-profile", "profile_resource-usage.json"],
      ["log", "live_backing.log"],
      ["test-profile", "profile_test_async_transactions.js.json.gz"],
      ["test-profile", "profile_test_command_line_handler.js.json.gz"],
      ["test-profile", "profile_test_permmanager_migrate_7-8.js.json.gz"],
      ["test-profile", "profile_test_quicksuggest_yelp.js.json.gz"],
      ["errorsummary", "xpcshell_errorsummary.log"],
    ]);
    const log = r.files.find((f) => f.kind === "log");
    assert.equal(log?.path, join(dir, "0", "live_backing.log"));
    assert.equal(readFileSync(log.path, "utf8"), "run 0: public/logs/live_backing.log");
    assert.equal(log.bytes, "run 0: public/logs/live_backing.log".length);
    assert.ok(r.files.every((f) => !f.skipped));

    const downloads = requests.filter((u) => u.includes("/artifacts/")).length;
    const again = await fetchArtifacts(RZLA, { run: 0, into: dir, fetchImpl });
    assert.ok(again.files.every((f) => f.skipped));
    assert.equal(again.files.length, r.files.length);
    assert.equal(requests.filter((u) => u.includes("/artifacts/")).length, downloads, "no download the second time");
  }));

test("fetchArtifacts keeps each run of a retried task apart", () =>
  inTmp(async (dir) => {
    const listing = json(`list-${RZLA}.json`);
    const { fetchImpl } = fakeQueue(
      RZLA,
      { ...withRunStates(["exception", "completed"]), [LISTING_URL(0)]: listing, [LISTING_URL(1)]: listing },
      { 0: rzlaFiles(listing.artifacts, 0), 1: rzlaFiles(listing.artifacts, 1) },
    );
    const first = await fetchArtifacts(RZLA, { run: 0, into: dir, fetchImpl });
    const latest = await fetchArtifacts(RZLA, { into: dir, fetchImpl });
    assert.equal(first.run, 0);
    assert.equal(latest.run, 1);
    assert.equal(latest.state, "completed");
    assert.ok(latest.files.every((f) => !f.skipped));
    const log = latest.files.find((f) => f.kind === "log");
    assert.equal(readFileSync(log!.path, "utf8"), "run 1: public/logs/live_backing.log");
  }));

test("fetchArtifacts refuses a run that hasn't finished", () =>
  inTmp(async (dir) => {
    const { fetchImpl, requests } = fakeQueue(RZLA, withRunStates(["failed", "running"]), {});
    await assert.rejects(fetchArtifacts(RZLA, { into: dir, fetchImpl }), /run 1 of task RZLa8YCLTly4eYhOPFYYyA is running/);
    assert.ok(!requests.some((u) => u.includes("/artifacts")));
    await assert.rejects(fetchArtifacts(RZLA, { run: 4, into: dir, fetchImpl }), /has no run 4/);
  }));

test("fetchArtifacts finds a profile the listing lacks through the Artifact markers", () =>
  inTmp(async (dir) => {
    const listing = json(`list-${RZLA}.json`);
    const files = rzlaFiles(listing.artifacts);
    const lacking = {
      artifacts: listing.artifacts.filter((a: Artifact) => !a.name.endsWith("profile_test_quicksuggest_yelp.js.json.gz") && !a.name.endsWith("errorsummary.log")),
    };
    delete files["public/test_info/xpcshell_errorsummary.log"]; // named by a marker, but gone
    const { fetchImpl } = fakeQueue(RZLA, { [LISTING_URL(0)]: lacking }, { 0: files });
    const r = await fetchArtifacts(RZLA, { run: 0, into: dir, fetchImpl });
    assert.ok(r.files.some((f) => f.name === "profile_test_quicksuggest_yelp.js.json.gz" && f.kind === "test-profile"));
    assert.deepEqual(r.missing, [{ name: "xpcshell_errorsummary.log", reason: "HTTP 404" }]);
  }));

test("fetchArtifacts reports a job with no resource-usage profile", () =>
  inTmp(async (dir) => {
    const listing = json(`list-${RZLA}.json`);
    const without = { artifacts: listing.artifacts.filter((a: Artifact) => !a.name.endsWith("profile_resource-usage.json")) };
    const { fetchImpl } = fakeQueue(RZLA, { [LISTING_URL(0)]: without }, { 0: rzlaFiles(listing.artifacts) });
    // Partial download left by an interrupted fetch: not mistaken for a finished file.
    mkdirSync(join(dir, "0"));
    writeFileSync(join(dir, "0", "live_backing.log.part"), "half");
    const r = await fetchArtifacts(RZLA, { run: 0, into: dir, fetchImpl });
    assert.deepEqual(r.missing, [{ name: "profile_resource-usage.json", reason: "not in the artifact listing" }]);
    assert.equal(r.files.length, 6);
    assert.ok(r.files.every((f) => !f.skipped));
  }));

