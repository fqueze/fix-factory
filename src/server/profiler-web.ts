// The Firefox Profiler front end the factory builds (tools.ts update), served on its own port: profile links
// open it on the page's host, so it fetches the profiles from there over plain http, from any machine.
// Only the profiler's public files: no host check.
import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".ftl": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

// The file under dir (a link to the current build, read again on each request) for a path; the app's
// routes (/from-url/…) are index.html.
export function profilerFile(dir: string, path: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const root = realpathSync(dir);
  const file = resolve(root, `.${decodeURIComponent(path)}`);
  if (file !== root && !file.startsWith(root + sep)) return undefined;
  return existsSync(file) && statSync(file).isFile() ? file : join(root, "index.html");
}

export function createProfilerServer(dir: string): Server {
  return createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    let file: string | undefined;
    try {
      file = profilerFile(dir, path);
    } catch {
      file = undefined; // a malformed escape
    }
    if (!file) {
      res.writeHead(existsSync(dir) ? 404 : 503, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(existsSync(dir) ? "not found\n" : "The profiler isn't built yet: node src/cli/tools.ts update\n");
      return;
    }
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  });
}
