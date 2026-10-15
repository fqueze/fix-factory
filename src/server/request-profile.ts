// A Firefox Profiler profile (processed format v64, markers only) showing what the
// factory did for one request: a track per work item plus one for the request,
// an interval marker per job, try push and wait for you. Modeled on
// createFirefoxProfile in https://github.com/fqueze/claude-profiler.

import type { Event, ItemId, RequestState } from "../types.ts";

const CATEGORIES = [
  { name: "Other", color: "grey", subcategories: ["Other"] },
  { name: "Script", color: "green", subcategories: ["Other"] },
  { name: "Agent", color: "purple", subcategories: ["Other"] },
  { name: "Build", color: "orange", subcategories: ["Other"] },
  { name: "Try", color: "blue", subcategories: ["Other"] },
  { name: "Waiting for you", color: "yellow", subcategories: ["Other"] },
  { name: "Failed", color: "red", subcategories: ["Other"] },
];
const CATEGORY = { other: 0, script: 1, agent: 2, build: 3, try: 4, user: 5, failed: 6 } as const;
const JOB_CATEGORY = { script: CATEGORY.script, agent: CATEGORY.agent, build: CATEGORY.build, "try-watch": CATEGORY.try } as const;

const MARKER_SCHEMA = [
  {
    name: "Job",
    tooltipLabel: "{marker.name}",
    tableLabel: "{marker.name} ({marker.data.kind}) {marker.data.model}",
    chartLabel: "{marker.name}",
    display: ["marker-chart", "marker-table", "timeline-overview"],
    fields: [
      { key: "kind", label: "Kind", format: "string" },
      { key: "model", label: "Model", format: "string" },
      { key: "status", label: "Status", format: "string" },
      { key: "exitCode", label: "Exit code", format: "integer" },
      { key: "duration", label: "Duration", format: "duration" },
      { key: "cost", label: "Cost ($)", format: "decimal" },
      { key: "job", label: "Job", format: "unique-string" },
      { key: "cmd", label: "Command", format: "string" },
      { key: "error", label: "Error", format: "string" },
    ],
  },
  {
    name: "TryPush",
    tooltipLabel: "{marker.name}: {marker.data.purpose}",
    tableLabel: "{marker.name}: {marker.data.purpose} ({marker.data.result})",
    chartLabel: "{marker.data.purpose}",
    display: ["marker-chart", "marker-table", "timeline-overview"],
    fields: [
      { key: "purpose", label: "Purpose", format: "string" },
      { key: "result", label: "Result", format: "string" },
      { key: "summary", label: "Summary", format: "string" },
      { key: "url", label: "Treeherder", format: "url" },
    ],
  },
  {
    name: "NeedsUser",
    tooltipLabel: "waiting for you: {marker.data.action}",
    tableLabel: "waiting for you: {marker.data.action}",
    chartLabel: "{marker.data.action}",
    display: ["marker-chart", "marker-table", "timeline-overview"],
    fields: [
      { key: "action", label: "Action", format: "string" },
      { key: "detail", label: "Detail", format: "string" },
    ],
  },
];

interface Markers {
  data: Record<string, unknown>[];
  name: number[];
  startTime: number[];
  endTime: (number | null)[];
  phase: number[];
  category: number[];
  length: number;
}

interface Track {
  name: string;
  processName: string;
  markers: Markers;
  first: number;
}

// `now` (ms) closes the intervals that haven't ended yet.
export function buildRequestProfile(state: RequestState, events: Event[], now: number): object {
  const startTime = Date.parse(state.createdAt);
  const strings: string[] = [];
  const stringIndex = new Map<string, number>();
  const intern = (s: string): number => {
    let i = stringIndex.get(s);
    if (i === undefined) {
      i = strings.length;
      strings.push(s);
      stringIndex.set(s, i);
    }
    return i;
  };

  const newTrack = (name: string, processName: string): Track => ({
    name,
    processName,
    markers: { data: [], name: [], startTime: [], endTime: [], phase: [], category: [], length: 0 },
    first: Infinity,
  });
  const requestTrack = newTrack("Request", state.text.split("\n")[0] || state.id);
  const itemTracks = new Map<ItemId, Track>();
  for (const item of Object.values(state.items)) {
    const tests = item.group.tests;
    itemTracks.set(item.id, newTrack(tests.length === 1 ? tests[0] : `${item.folder} (${tests.length} tests)`, item.id));
  }
  const trackFor = (item: ItemId | undefined): Track => (item !== undefined && itemTracks.get(item)) || requestTrack;

  const add = (track: Track, name: string, start: number, end: number, category: number, data: Record<string, unknown>) => {
    const s = start - startTime;
    const e = Math.max(end, start) - startTime;
    const m = track.markers;
    m.name.push(intern(name));
    m.startTime.push(s);
    m.endTime.push(e);
    m.phase.push(1); // interval
    m.category.push(category);
    m.data.push(data);
    m.length++;
    track.first = Math.min(track.first, s);
  };

  for (const job of Object.values(state.jobs)) {
    const start = Date.parse(job.startedAt);
    const running = job.endedAt === undefined;
    const end = running ? now : Date.parse(job.endedAt!);
    const failed = !running && job.exitCode !== 0;
    add(trackFor(job.item), job.name, start, end, failed ? CATEGORY.failed : JOB_CATEGORY[job.kind], {
      type: "Job",
      kind: job.kind,
      model: job.model,
      status: running ? "running" : failed ? "failed" : "done",
      exitCode: job.exitCode,
      duration: job.durationMs ?? end - start,
      cost: job.costUsd,
      job: intern(job.job),
      cmd: job.cmd.join(" "),
      error: job.error,
    });
  }

  // Try pushes and waits for you are only in the events: the folded state keeps
  // neither their times nor the needs-user entries that are closed.
  const pushed = new Map<string, number>();
  const waiting = new Map<string, { t: number; action: string; detail: string; item?: ItemId }>();
  for (const e of events) {
    const t = Date.parse(e.t);
    if (e.type === "try-pushed") {
      pushed.set(e.push, t);
    } else if (e.type === "try-finished" && pushed.has(e.push)) {
      const push = state.pushes[e.push];
      add(requestTrack, `Try push ${push?.rev?.slice(0, 12) ?? e.push}`, pushed.get(e.push)!, t, CATEGORY.try, {
        type: "TryPush",
        purpose: push?.purpose ?? "",
        result: e.result,
        summary: e.summary,
        url: push?.url,
      });
      pushed.delete(e.push);
    } else if (e.type === "needs-user") {
      waiting.set(e.key, { t, action: e.action, detail: e.detail, item: e.item });
    } else if (e.type === "user-done" && waiting.has(e.key)) {
      const w = waiting.get(e.key)!;
      add(trackFor(w.item), "waiting for you", w.t, t, CATEGORY.user, { type: "NeedsUser", action: w.action, detail: w.detail });
      waiting.delete(e.key);
    }
  }
  for (const [id, t] of pushed) {
    const push = state.pushes[id];
    add(requestTrack, `Try push ${push?.rev?.slice(0, 12) ?? id}`, t, now, CATEGORY.try, { type: "TryPush", purpose: push?.purpose ?? "", result: "running", url: push?.url });
  }
  // Without events, the open entries still show, from the folded state.
  const open = events.length ? [...waiting.values()] : state.needsUser.map((n) => ({ t: Date.parse(n.since), action: n.action, detail: n.detail, item: n.item }));
  for (const w of open) {
    add(trackFor(w.item), "waiting for you", w.t, now, CATEGORY.user, { type: "NeedsUser", action: w.action, detail: w.detail });
  }

  const end = Math.max(now, Date.parse(state.updatedAt)) - startTime;
  const tracks = [requestTrack, ...itemTracks.values()];
  const threads = tracks.map((track, index) => ({
    processType: "default",
    processName: track.processName,
    processStartupTime: 0,
    processShutdownTime: null,
    registerTime: Number.isFinite(track.first) ? track.first : 0,
    unregisterTime: null,
    pausedRanges: [],
    showMarkersInTimeline: true,
    name: track.name,
    isMainThread: true,
    // Numeric and increasing: the profiler orders process tracks by pid.
    pid: index,
    tid: index,
    samples: { length: 0, stack: [], time: [], weight: null, weightType: "samples" },
    markers: track.markers,
  }));

  return {
    meta: {
      processType: 0,
      product: `Fix factory: ${state.id}`,
      stackwalk: 0,
      version: 64,
      preprocessedProfileVersion: 64,
      symbolicationNotSupported: true,
      interval: 1,
      startTime,
      profilingStartTime: 0,
      profilingEndTime: end,
      markerSchema: MARKER_SCHEMA,
      categories: CATEGORIES,
      usesOnlyOneStackType: true,
    },
    libs: [],
    threads,
    shared: {
      stringArray: strings,
      stackTable: { length: 0, prefix: [], frame: [] },
      frameTable: { length: 0, address: [], inlineDepth: [], category: [], subcategory: [], func: [], nativeSymbol: [], innerWindowID: [], originalLocation: [], line: [], column: [] },
      funcTable: { length: 0, name: [], isJS: [], relevantForJS: [], resource: [], source: [], lineNumber: [], columnNumber: [], originalLocation: [] },
      resourceTable: { length: 0, lib: [], name: [], host: [], type: [] },
      nativeSymbols: { length: 0, address: [], functionSize: [], libIndex: [], name: [] },
      sources: { length: 0, id: [], filename: [], startLine: [], startColumn: [], sourceMapURL: [], content: [] },
      sourceLocationTable: { length: 0, source: [], line: [], column: [] },
    },
    counters: [],
  };
}
