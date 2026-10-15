import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const FIXTURES = new URL("../../test/fixtures/failures/artifacts/", import.meta.url);
const text = (name: string) => readFileSync(new URL(name, FIXTURES), "utf8");
const json = (name: string) => JSON.parse(text(name));

// A fake Taskcluster queue: JSON endpoints from fixtures, artifact downloads from `files`.
function fakeQueue(taskId: string, routes: Record<string, unknown>, files: Record<string, string>) {
  const requests: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url in routes) return Response.json(routes[url]);
    const prefix = `${QUEUE}/task/${taskId}/runs/0/artifacts/`;
    if (url.startsWith(prefix)) {
      const name = decodeURIComponent(url.slice(prefix.length));
      if (!(name in files)) return new Response("not found", { status: 404 });
      return new Response(files[name]);
    }
    return new Response("unexpected", { status: 500 });
  }) as Fetch;
  return { fetchImpl, requests };
}

const RZLA = "RZLa8YCLTly4eYhOPFYYyA";

function rzlaFiles(listing: Artifact[]): Record<string, string> {
  const files: Record<string, string> = {};
  for (const a of listing) files[a.name] = `content of ${a.name}`;
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

test("fetchArtifacts downloads what's needed, then skips it the second time", async () => {
  const dir = mkdtempSync(join(tmpdir(), "artifacts-test-"));
  try {
    const listing = json(`list-${RZLA}.json`);
    const { fetchImpl, requests } = fakeQueue(
      RZLA,
      { [`${QUEUE}/task/${RZLA}/status`]: json(`status-${RZLA}.json`), [`${QUEUE}/task/${RZLA}/runs/0/artifacts`]: listing },
      rzlaFiles(listing.artifacts),
    );
    const r = await fetchArtifacts(RZLA, { into: dir, fetchImpl });
    assert.equal(r.run, 0);
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
    assert.equal(readFileSync(join(dir, "live_backing.log"), "utf8"), "content of public/logs/live_backing.log");
    assert.equal(log?.bytes, "content of public/logs/live_backing.log".length);
    assert.ok(r.files.every((f) => !f.skipped));

    const downloads = requests.filter((u) => u.includes("/artifacts/")).length;
    const again = await fetchArtifacts(RZLA, { run: 0, into: dir, fetchImpl });
    assert.ok(again.files.every((f) => f.skipped));
    assert.equal(again.files.length, r.files.length);
    assert.equal(requests.filter((u) => u.includes("/artifacts/")).length, downloads, "no download the second time");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchArtifacts finds a profile the listing lacks through the Artifact markers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "artifacts-test-"));
  try {
    const listing = json(`list-${RZLA}.json`);
    const files = rzlaFiles(listing.artifacts);
    const lacking = {
      artifacts: listing.artifacts.filter((a: Artifact) => !a.name.endsWith("profile_test_quicksuggest_yelp.js.json.gz") && !a.name.endsWith("errorsummary.log")),
    };
    delete files["public/test_info/xpcshell_errorsummary.log"]; // named by a marker, but gone
    const { fetchImpl } = fakeQueue(RZLA, { [`${QUEUE}/task/${RZLA}/runs/0/artifacts`]: lacking }, files);
    const r = await fetchArtifacts(RZLA, { run: 0, into: dir, fetchImpl });
    assert.ok(r.files.some((f) => f.name === "profile_test_quicksuggest_yelp.js.json.gz" && f.kind === "test-profile"));
    assert.deepEqual(r.missing, [{ name: "xpcshell_errorsummary.log", reason: "HTTP 404" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchArtifacts reports a job with no resource-usage profile", async () => {
  const dir = mkdtempSync(join(tmpdir(), "artifacts-test-"));
  try {
    const listing = json(`list-${RZLA}.json`);
    const without = { artifacts: listing.artifacts.filter((a: Artifact) => !a.name.endsWith("profile_resource-usage.json")) };
    const { fetchImpl } = fakeQueue(RZLA, { [`${QUEUE}/task/${RZLA}/runs/0/artifacts`]: without }, rzlaFiles(listing.artifacts));
    // Partial download left by an interrupted run: not mistaken for a finished file.
    writeFileSync(join(dir, "live_backing.log.part"), "half");
    const r = await fetchArtifacts(RZLA, { run: 0, into: dir, fetchImpl });
    assert.deepEqual(r.missing, [{ name: "profile_resource-usage.json", reason: "not in the artifact listing" }]);
    assert.equal(r.files.length, 6);
    assert.ok(r.files.every((f) => !f.skipped));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
