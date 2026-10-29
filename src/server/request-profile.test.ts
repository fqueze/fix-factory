import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { buildRequestProfile } from "./request-profile.ts";
import { FixtureStateSource } from "./state-source.ts";

const source = new FixtureStateSource(resolve(import.meta.dirname, "../../test/fixtures/server"));
const NOW = Date.parse("2026-10-15T09:00:00Z");
const ID = "r-20261010-xpcshell-cwd";

interface Markers {
  data: Record<string, unknown>[];
  name: number[];
  startTime: number[];
  endTime: number[];
  phase: number[];
  category: number[];
  length: number;
}
interface Thread {
  name: string;
  pid: number;
  tid: number;
  processType: string;
  samples: { length: number };
  markers: Markers;
}
interface Profile {
  meta: { version: number; preprocessedProfileVersion: number; startTime: number; markerSchema: { name: string; fields: { key: string; format: string }[] }[]; categories: { name: string; color: string }[] };
  threads: Thread[];
  shared: { stringArray: string[]; stackTable: { length: number }; frameTable: { length: number }; funcTable: { length: number } };
  libs: unknown[];
}

function build(id = ID): Profile {
  const state = source.getRequest(id)!;
  return buildRequestProfile(state, source.getEvents(id), NOW) as Profile;
}

function markers(p: Profile, thread: Thread) {
  const m = thread.markers;
  return m.name.map((n, i) => ({ name: p.shared.stringArray[n], start: m.startTime[i], end: m.endTime[i], phase: m.phase[i], category: m.category[i], data: m.data[i] }));
}

describe("request profile", () => {
  it("has the structure of a processed v64 profile", () => {
    const p = build();
    assert.equal(p.meta.version, 64);
    assert.equal(p.meta.preprocessedProfileVersion, 64);
    assert.equal(p.meta.startTime, Date.parse("2026-10-10T08:00:00.000Z"));
    assert.ok(Array.isArray(p.libs));
    assert.ok(Array.isArray(p.shared.stringArray));
    for (const table of [p.shared.stackTable, p.shared.frameTable, p.shared.funcTable]) {
      assert.equal(table.length, 0);
    }
    const schemas = new Set(p.meta.markerSchema.map((s) => s.name));
    for (const t of p.threads) {
      assert.equal(t.processType, "default");
      assert.equal(t.samples.length, 0);
      const m = t.markers;
      for (const col of [m.name, m.startTime, m.endTime, m.phase, m.category, m.data]) {
        assert.equal(col.length, m.length);
      }
      for (const [i, d] of m.data.entries()) {
        assert.ok(schemas.has(d.type as string), `marker data type ${String(d.type)} has a schema`);
        assert.ok(m.name[i] < p.shared.stringArray.length);
        assert.ok(m.category[i] < p.meta.categories.length);
        assert.equal(m.phase[i], 1);
        assert.ok(m.endTime[i] >= m.startTime[i]);
      }
    }
    assert.deepEqual(p.threads.map((t) => t.pid), p.threads.map((_, i) => i));
  });

  it("has a track for the request and one per work item", () => {
    const p = build();
    const state = source.getRequest(ID)!;
    assert.equal(p.threads.length, 1 + Object.keys(state.items).length);
    assert.equal(p.threads[0].name, "Request");
    assert.ok(p.threads.some((t) => t.name === "browser/components/migration/tests/unit (31 tests)"));
  });

  it("has only one group's track when asked for it", () => {
    const state = source.getRequest(ID)!;
    const item = Object.values(state.items).find((i) => i.jobs.length)!;
    const p = buildRequestProfile(state, source.getEvents(ID), NOW, item.id) as Profile;
    assert.equal(p.threads.length, 1);
    assert.equal(p.threads[0].name, item.group.tests.length === 1 ? item.group.tests[0] : `${item.folder} (${item.group.tests.length} tests)`);
    assert.equal(p.threads[0].markers.length >= item.jobs.length, true);
  });

  it("has an interval marker per job, on its item's track, with kind, model, exit code, duration and cost", () => {
    const p = build();
    const copy = p.threads.find((t) => t.name === "storage/test/unit/test_backup.js")!;
    const [job] = markers(p, copy);
    assert.equal(job.name, "investigate-and-fix");
    assert.equal(job.end - job.start, 75 * 60000);
    assert.equal(job.data.kind, "agent");
    assert.equal(job.data.model, "opus");
    assert.equal(job.data.exitCode, 0);
    assert.equal(job.data.duration, 75 * 60000);
    assert.equal(job.data.cost, 6.4);
    assert.equal(p.shared.stringArray[job.data.job as number], "j-inv-copy", "unique-string fields are string indexes");

    const ssl = markers(p, p.threads.find((t) => t.name === "security/manager/ssl/tests/unit/test_cert_db.js")!);
    const build_ = ssl.find((m) => m.data.kind === "build")!;
    assert.equal(build_.data.status, "failed");
    assert.equal(p.meta.categories[build_.category].name, "Failed");
    const running = ssl.find((m) => m.data.status === "running")!;
    assert.equal(running.end, NOW - p.meta.startTime, "running jobs end now");
  });

  it("has try push markers from push to finish, and waits for you from needs-user to user-done", () => {
    const p = build();
    const request = markers(p, p.threads[0]);
    const push = request.find((m) => m.data.type === "TryPush")!;
    assert.equal(push.name, "Try push 27999ea83b92");
    assert.equal(push.start, 4 * 60000);
    assert.equal(push.end, (3 * 60 + 5) * 60000);
    assert.equal(push.data.result, "failures");

    const update = markers(p, p.threads.find((t) => t.name.startsWith("toolkit/mozapps/update/tests"))!);
    const wait = update.find((m) => m.name === "waiting for you")!;
    assert.equal(wait.end - wait.start, 3 * 3600000);
    assert.equal(p.meta.categories[wait.category].name, "Waiting for you");

    const open = request.filter((m) => m.name === "waiting for you");
    assert.equal(open.length, 1, "the open approve-push:A entry runs until now");
    assert.equal(open[0].end, NOW - p.meta.startTime);
  });

  it("falls back on the open needs-user entries of the state without events", () => {
    const id = "r-20261013-dom-indexeddb";
    const p = buildRequestProfile(source.getRequest(id)!, [], NOW) as Profile;
    const quota = p.threads.find((t) => t.name === "dom/indexedDB/test/unit/test_quota.js")!;
    assert.ok(markers(p, quota).some((m) => m.name === "waiting for you"));
  });

  it("builds for every fixture", () => {
    for (const r of source.listRequests()) {
      assert.doesNotThrow(() => JSON.stringify(build(r.id)), r.id);
    }
  });
});
