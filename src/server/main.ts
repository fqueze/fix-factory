// `node src/server/main.ts`: the page over the state directory of factory.config.json
// (or $FACTORY_CONFIG).
// `node src/server/main.ts --fixtures test/fixtures/server/` serves fixture states and
// prints commands instead of appending them, to look at the page without the orchestrator.
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import type { FactoryConfig } from "../types.ts";
import { createFactoryServer, type FactoryServer } from "./server.ts";
import { StateDirCommandSink, StateDirSource } from "./state-dir.ts";
import { FixtureStateSource, type CommandSink } from "./state-source.ts";

export function main(args: string[]): FactoryServer {
  const { values } = parseArgs({ args, options: { fixtures: { type: "string" }, port: { type: "string" } } });
  let config: FactoryConfig;
  if (values.fixtures) {
    try {
      config = loadConfig();
    } catch {
      config = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../factory.config.example.json"), "utf8")) as FactoryConfig;
    }
  } else {
    config = loadConfig();
  }
  if (values.port !== undefined) {
    const port = Number(values.port);
    if (!/^\d+$/.test(values.port) || port > 65535) {
      process.stderr.write(`--port must be an integer from 0 to 65535, not ${JSON.stringify(values.port)}\n`);
      process.exit(2);
    }
    config.port = port;
  }

  let server: FactoryServer;
  let what: string;
  if (values.fixtures) {
    const state = new FixtureStateSource(resolve(values.fixtures));
    const stopWatching = state.watch();
    const sink: CommandSink = { append: (c) => process.stdout.write(JSON.stringify(c) + "\n") };
    // interdiffFile paths in the fixtures are relative to the fixture directory.
    config.stateDir = resolve(values.fixtures);
    server = createFactoryServer({ config, state, sink });
    server.on("close", stopWatching);
    what = `fixtures from ${values.fixtures}`;
  } else {
    const state = new StateDirSource(config.stateDir);
    state.start();
    server = createFactoryServer({ config, state, sink: new StateDirCommandSink(config.stateDir) });
    server.on("close", () => state.close());
    what = `state from ${config.stateDir}`;
  }
  // All interfaces: the page is often opened from another machine.
  server.listen(config.port, () => {
    process.stderr.write(`fix-factory page on http://localhost:${(server.address() as AddressInfo).port}/ (${what})\n`);
  });
  return server;
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
