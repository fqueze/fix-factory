import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { readCommands } from "../state/commands.ts";
import { appendEvent } from "../state/events.ts";

const dir = mkdtempSync(join(tmpdir(), "ff-main-test-"));
const stateDir = join(dir, "state");
const configPath = join(dir, "factory.config.json");
let child: ChildProcess;
let base = "";

before(async () => {
  const config = JSON.parse(readFileSync(join(import.meta.dirname, "../../factory.config.example.json"), "utf8"));
  writeFileSync(configPath, JSON.stringify({ ...config, port: 0, stateDir }));
  appendEvent(stateDir, { request: "r-20261015-smoke", type: "request-created", kind: "burndown", text: "burn down toolkit/smoke", folder: "toolkit/smoke" });
  child = spawn(process.execPath, [join(import.meta.dirname, "main.ts")], {
    env: { ...process.env, FACTORY_CONFIG: configPath },
    stdio: ["ignore", "ignore", "pipe"],
  });
  base = await new Promise<string>((resolve, reject) => {
    let err = "";
    child.stderr!.on("data", (d: Buffer) => {
      err += d.toString();
      const m = err.match(/(http:\/\/localhost:\d+)\//);
      if (m) resolve(m[1]);
    });
    child.on("exit", (code) => reject(new Error(`main.ts exited with ${code}: ${err}`)));
  });
});
after(() => {
  child.kill();
  rmSync(dir, { recursive: true, force: true });
});

describe("main.ts", () => {
  it("serves the overview of the configured state directory", async () => {
    const r = await fetch(`${base}/`);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /toolkit\/smoke/);
  });

  it("appends a valid command to commands.jsonl", async () => {
    const r = await fetch(`${base}/api/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cmd: "presence", visible: true }),
    });
    assert.equal(r.status, 200);
    const { commands } = readCommands(stateDir, 0);
    assert.deepEqual(
      commands.map((c) => [c.cmd, "visible" in c && c.visible]),
      [["presence", true]],
    );
  });
});
