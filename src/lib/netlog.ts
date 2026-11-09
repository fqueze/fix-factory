// Every network request a factory script makes, one JSON line each in the file FACTORY_NET_LOG names (its job's
// net.jsonl, which the runner sets): the request's profile shows them inside its job. Without it, nothing is written.
import { appendFileSync } from "node:fs";

export interface NetEntry {
  start: number; // ms since the epoch
  end: number;
  method: string; // GET, POST, a Conduit method ("conduit differential.revision.search"), "git fetch"
  url: string; // without its query string, which may carry a token
  status?: number; // HTTP status; absent when it failed before one
  bytes?: number;
  error?: string;
}

export function netLog(e: NetEntry): void {
  const file = process.env.FACTORY_NET_LOG;
  if (file) appendFileSync(file, JSON.stringify(e) + "\n");
}

export function bareUrl(url: string): string {
  return url.split("?")[0];
}

// The global fetch, logging each request: installed once by every script (src/lib/cli.ts).
export function logFetches(): void {
  const original = globalThis.fetch;
  if ((original as { logged?: true }).logged) return;
  const logged = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const start = Date.now();
    const method = init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
    try {
      const res = await original(input, init);
      const length = Number(res.headers.get("content-length"));
      netLog({ start, end: Date.now(), method, url: bareUrl(url), status: res.status, ...(length ? { bytes: length } : {}) });
      return res;
    } catch (e) {
      netLog({ start, end: Date.now(), method, url: bareUrl(url), error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }) as typeof fetch & { logged?: true };
  logged.logged = true;
  globalThis.fetch = logged;
}
