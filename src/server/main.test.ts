import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { readCommands } from "../state/commands.ts";
import { appendEvent } from "../state/events.ts";

const MAIN = join(import.meta.dirname, "main.ts");
const FIXTURES = resolve(import.meta.dirname, "../../test/fixtures/server");
const dir = mkdtempSync(join(tmpdir(), "ff-main-test-"));
const stateDir = join(dir, "state");
const configPath = join(dir, "factory.config.json");
const env = { ...process.env, FACTORY_CONFIG: configPath };
const children: ChildProcess[] = [];

// Starts main.ts and resolves with its base URL and what it prints on stdout.
function startMain(args: string[]): Promise<{ base: string; stdout: () => string }> {
  const child = spawn(process.execPath, [MAIN, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let out = "";
  child.stdout!.on("data", (d: Buffer) => (out += d.toString()));
  return new Promise((resolve, reject) => {
    let err = "";
    child.stderr!.on("data", (d: Buffer) => {
      err += d.toString();
      const m = err.match(/(http:\/\/localhost:\d+)\//);
      if (m) resolve({ base: m[1], stdout: () => out });
    });
    child.on("exit", (code) => reject(new Error(`main.ts exited with ${code}: ${err}`)));
  });
}

function postPresence(base: string) {
  return fetch(`${base}/api/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cmd: "presence", visible: true }),
  });
}

before(() => {
  const config = JSON.parse(readFileSync(join(import.meta.dirname, "../../factory.config.example.json"), "utf8"));
  writeFileSync(configPath, JSON.stringify({ ...config, port: 0, stateDir }));
  appendEvent(stateDir, { request: "r-20261015-smoke", type: "request-created", kind: "burndown", text: "burn down toolkit/smoke", folder: "toolkit/smoke" });
});
after(() => {
  for (const c of children) c.kill();
  rmSync(dir, { recursive: true, force: true });
});

describe("main.ts", () => {
  it("serves the configured state directory and appends commands to commands.jsonl", async () => {
    const { base } = await startMain([]);
    const r = await fetch(`${base}/`);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /toolkit\/smoke/);
    assert.equal((await postPresence(base)).status, 200);
    const { commands } = readCommands(stateDir, 0);
    assert.deepEqual(
      commands.map((c) => [c.cmd, "visible" in c && c.visible]),
      [["presence", true]],
    );
  });

  it("serves fixtures with --fixtures and prints commands instead", async () => {
    const { base, stdout } = await startMain(["--fixtures", FIXTURES, "--port", "0"]);
    assert.match(await (await fetch(`${base}/`)).text(), /data-request="r-20261005-newtab"/);
    assert.equal((await postPresence(base)).status, 200);
    // The pipe can deliver the line after the response.
    for (let i = 0; i < 100 && !stdout().includes("\n"); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.deepEqual(JSON.parse(stdout()),{ cmd: "presence", visible: true });
  });

  it("rejects a port that isn't an integer", () => {
    const r = spawnSync(process.execPath, [MAIN, "--port", "80x"], { env, encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--port must be an integer/);
  });
});
