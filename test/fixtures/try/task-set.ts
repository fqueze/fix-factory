// A tiny task set, shaped like the ones mach try caches (json.dump of label → task, without spaces).

function task(label: string, platform: string, collection: string, symbol: string, opts: { group?: string; tier?: number; build?: string; kind?: string; buildPlatform?: string } = {}) {
  return {
    kind: opts.kind ?? "test",
    label,
    attributes: opts.buildPlatform ? { build_platform: opts.buildPlatform, build_type: collection === "debug" ? "debug" : "opt" } : {},
    dependencies: opts.build ? { build: opts.build, "docker-image": "docker-image-x" } : {},
    task: {
      extra: {
        chunks: { current: 1, total: 2 },
        treeherder: { machine: { platform }, collection: { [collection]: true }, ...(opts.group ? { groupSymbol: opts.group } : {}), symbol, jobKind: opts.kind ?? "test", tier: opts.tier ?? 1 },
      },
    },
  };
}

export const TASKS = [
  task("build-linux64/debug", "linux64", "debug", "B", { kind: "build", buildPlatform: "linux64" }),
  task("build-linux64-asan/opt", "linux64", "asan", "Bo", { kind: "build", buildPlatform: "linux64-asan" }),
  task("test-linux2404-64/debug-xpcshell-1", "linux2404-64", "debug", "X1", { group: "X", build: "build-linux64/debug" }),
  task("test-linux2404-64/debug-xpcshell-2", "linux2404-64", "debug", "X2", { group: "X", build: "build-linux64/debug" }),
  task("test-linux2404-64/debug-xpcshell-2-cf", "linux2404-64", "debug", "X2-cf", { group: "X", build: "build-linux64/debug" }),
  task("test-linux2404-64/debug-xpcshell-nofis-1", "linux2404-64", "debug", "X1", { group: "X-nofis", tier: 2, build: "build-linux64/debug" }),
  task("test-linux2404-64-asan/opt-xpcshell", "linux2404-64-asan", "opt", "X", { group: "X", build: "build-linux64-asan/opt" }),
];

export function fakeTaskSet(): string {
  return JSON.stringify(Object.fromEntries(TASKS.map((t) => [t.label, t])));
}
