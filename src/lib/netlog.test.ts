import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logFetches } from "./netlog.ts";

test("logFetches writes each request to FACTORY_NET_LOG, without its query string", async () => {
  const dir = mkdtempSync(join(tmpdir(), "netlog-"));
  const original = globalThis.fetch;
  try {
    process.env.FACTORY_NET_LOG = join(dir, "net.jsonl");
    globalThis.fetch = (async () => new Response("ok", { status: 429, headers: { "content-length": "2" } })) as typeof fetch;
    logFetches();
    const res = await fetch("https://example.com/api/x?token=secret", { method: "POST" });
    assert.equal(res.status, 429);
    const [e] = readFileSync(process.env.FACTORY_NET_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual([e.method, e.url, e.status, e.bytes], ["POST", "https://example.com/api/x", 429, 2]);
    assert.ok(e.end >= e.start);
  } finally {
    globalThis.fetch = original;
    delete process.env.FACTORY_NET_LOG;
    rmSync(dir, { recursive: true, force: true });
  }
});
