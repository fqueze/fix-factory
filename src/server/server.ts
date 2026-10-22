import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statfsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { parseStreamJson, transcriptPath } from "../agents/run.ts";
import { jobDir } from "../state/jobs.ts";
import type { FactoryConfig, JobView, PatchView } from "../types.ts";
import { HostCheck } from "./host-check.ts";
import { commandsFromForm, validateCommand } from "./commands.ts";
import { conversationOf, jobUrl, renderActivity, type Activity } from "./pages/activity.ts";
import type { RenderContext } from "./pages/common.ts";
import { renderMain, renderOverview, renderStrip } from "./pages/overview.ts";
import { renderRequest } from "./pages/request.ts";
import { buildRequestProfile } from "./request-profile.ts";
import { buildPatchView, buildPushView, buildStackReview, isRevName } from "./stack-review.ts";
import { AGENT_FILE_CSP, AGENT_FILES, agentFilePath, renderAgentFile, type AgentFile } from "./agent-files.ts";
import { pushTasks } from "./pages/tasks.ts";
import type { DryRunResult } from "../cli/try.ts";
import { dryRunJobs, type TryJob } from "../cli/task-set.ts";
import type { CommandInput } from "../state/commands.ts";
import type { CommandSink, StateSource } from "./state-source.ts";

export interface ServerOptions {
  config: Pick<FactoryConfig, "port" | "profilerOrigin" | "stackViewerCommand" | "mdViewerCommand" | "diffViewerCommand" | "stateDir" | "maxAgents" | "maxBuilds" | "allowedHosts" | "bugzillaEmail" | "worktreesDir" | "firefoxRepo">;
  state: StateSource;
  sink: CommandSink;
  now?: () => number;
  machineName?: string; // os.hostname() by default
  homeDir?: string; // where agent transcripts are, under .claude/projects; os.homedir() by default
  claudeProfiler?: string | null; // its main module, null when not installed; looked up on PATH by default
  mozbuildStateDir?: string; // where mach caches try task sets; $MOZBUILD_STATE_PATH or ~/.mozbuild by default
}

// The part of claude-profiler's library API the agent profile uses (see docs/research/tools.md).
interface Profiler {
  readJsonlFile(path: string): unknown[];
  createFirefoxProfile(entries: unknown[]): unknown;
}

// claude-profiler is an optional tool, not a dependency: its command on PATH is a link to its main module.
function findClaudeProfiler(): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    try {
      return realpathSync(join(dir, "claude-profiler"));
    } catch {
      // not in this directory
    }
  }
  return null;
}

export type FactoryServer = Server & { sseClientCount(): number };

const HEARTBEAT_MS = 30_000;

const STATIC: Record<string, { file: string; type: string }> = {
  "/client.js": { file: "client.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};

const MAX_BODY = 1 << 20;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function createFactoryServer(opts: ServerOptions): FactoryServer {
  const now = opts.now ?? Date.now;
  const homeDir = opts.homeDir ?? homedir();
  const hosts = new HostCheck(opts.config.allowedHosts ?? [], opts.machineName);
  void hosts.addFqdn(opts.machineName);
  const bootId = String(now());
  // client.js reloads a page served by an earlier run of the server once it hears this one's id.
  const page = (text: string) => text.replace("<body>", `<body data-boot="${bootId}">`);
  // The jobs of dry runs that didn't record them, by dry run job: reading a task set takes a while.
  const pushJobs = new Map<string, TryJob[] | undefined>();
  const pushCommits = new Map<string, { sha: string; subject: string }[]>();
  // The latest dry run of a push says what it would run and carry.
  function pushDryRun(requestId: string, pushId: string) {
    const request = getRequest(decodeURIComponent(requestId));
    const push = request.pushes[decodeURIComponent(pushId)];
    const dry = push && Object.values(request.jobs).findLast((j) => j.purpose?.push === push.id && j.name.startsWith("try.ts dry-run") && j.exitCode === 0);
    const out = dry && join(opts.config.stateDir, "jobs", dry.job, "out.log");
    if (!dry || !out || !existsSync(out)) {
      throw new HttpError(404, "no dry run for this push");
    }
    return { dry, d: JSON.parse(readFileSync(out, "utf8")) as DryRunResult };
  }
  const sseClients = new Set<ServerResponse>();
  const broadcast = (data: string) => {
    for (const res of sseClients) {
      res.write(data);
    }
  };
  const unsubscribe = opts.state.subscribe((id) => broadcast(`event: changed\ndata: ${JSON.stringify(id)}\n\n`));
  // Keeps idle connections from being dropped by proxies, and finds dead clients.
  const heartbeat = setInterval(() => broadcast(": heartbeat\n\n"), HEARTBEAT_MS);
  heartbeat.unref();

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) {
        process.stderr.write(`${req.method} ${req.url}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      }
      if (!res.headersSent) {
        send(res, status, wantsJson(req) ? "application/json" : "text/plain; charset=utf-8", wantsJson(req) ? JSON.stringify({ error: errorMessage(e) }) : errorMessage(e));
      } else {
        res.end();
      }
    });
  });
  // An open event stream would keep close() waiting forever.
  const close = server.close.bind(server);
  const factoryServer = Object.assign(server, {
    sseClientCount: () => sseClients.size,
    close(callback?: (err?: Error) => void) {
      unsubscribe();
      clearInterval(heartbeat);
      for (const res of sseClients) {
        res.end();
      }
      sseClients.clear();
      return close(callback);
    },
  });

  function readInterdiff(p: PatchView): string | undefined {
    if (p.interdiffFile === undefined) {
      return undefined;
    }
    try {
      const root = realpathSync(opts.config.stateDir);
      const file = realpathSync(resolve(root, p.interdiffFile));
      const rel = relative(root, file);
      // Inside stateDir only, symlinks included.
      if (rel.startsWith("..") || isAbsolute(rel)) {
        return undefined;
      }
      return readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  }

  // The agent's out.log (stream-json) and prompt.md as a conversation, with links to its transcript and profile.
  function activity(request: string, job: JobView, req: IncomingMessage): Activity | undefined {
    const dir = jobDir(opts.config.stateDir, job.job);
    let log: string;
    try {
      log = readFileSync(join(dir, "out.log"), "utf8");
    } catch {
      return undefined; // not started writing yet
    }
    const transcript = transcriptOf(job) !== undefined;
    const api = `http://${req.headers.host ?? `localhost:${opts.config.port}`}${jobUrl(request, job.job, "profile")}`;
    return {
      prompt: existsSync(join(dir, "prompt.md")) ? readFileSync(join(dir, "prompt.md"), "utf8") : undefined,
      turns: conversationOf(log),
      summary: parseStreamJson(log),
      transcript,
      profileUrl: transcript && loadProfiler() ? `${opts.config.profilerOrigin}/from-url/${encodeURIComponent(api)}?thread=0` : undefined,
    };
  }

  // Inside ~/.claude/projects only: the cwd and session id come from the state.
  function transcriptOf(job: JobView): string | undefined {
    if (job.sessionId === undefined) {
      return undefined;
    }
    try {
      const root = realpathSync(join(homeDir, ".claude", "projects"));
      const file = realpathSync(transcriptPath(homeDir, job.cwd, job.sessionId));
      const rel = relative(root, file);
      return rel.startsWith("..") || isAbsolute(rel) ? undefined : file;
    } catch {
      return undefined;
    }
  }

  let profiler: Profiler | null | undefined;
  function loadProfiler(): Profiler | null {
    if (profiler === undefined) {
      const main = opts.claudeProfiler === undefined ? findClaudeProfiler() : opts.claudeProfiler;
      profiler = main === null ? null : (createRequire(main)(main) as Profiler);
    }
    return profiler;
  }

  // Free space where the worktrees go: the factory stops creating them below 20 GB.
  function freeDiskGB(): number | undefined {
    const dir = opts.config.worktreesDir;
    if (!existsSync(dir)) {
      return undefined;
    }
    const fs = statfsSync(dir);
    return (fs.bavail * fs.bsize) / 1e9;
  }

  function ctx(req: IncomingMessage, open?: string[]): RenderContext {
    return {
      profilerOrigin: opts.config.profilerOrigin,
      // The profiler front end fetches the profile from the browser, so it needs the
      // address the browser used, not the interface the server listens on.
      baseUrl: `http://${req.headers.host ?? `localhost:${opts.config.port}`}`,
      now: now(),
      maxAgents: opts.config.maxAgents,
      maxBuilds: opts.config.maxBuilds,
      runningBuilds: opts.state.listRequests().reduce((n, r) => n + Object.values(r.jobs).filter((j) => j.kind === "build" && j.endedAt === undefined).length, 0),
      runningAgents: opts.state.listRequests().reduce((n, r) => n + Object.values(r.jobs).filter((j) => j.kind === "agent" && j.endedAt === undefined).length, 0),
      open,
      bugzillaEmail: opts.config.bugzillaEmail,
      interdiff: readInterdiff,
      freeDiskGB: freeDiskGB(),
    };
  }

  function getRequest(id: string) {
    const r = opts.state.getRequest(id);
    if (!r) {
      throw new HttpError(404, `unknown request: ${id}`);
    }
    return r;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";
    let m: RegExpMatchArray | null;

    if (!hosts.allows(req.headers.host)) {
      throw new HttpError(421, `unknown host ${req.headers.host ?? ""}: add it to allowedHosts in factory.config.json`);
    }

    if (method === "OPTIONS" && path.startsWith("/api/requests/")) {
      res.writeHead(204, { "Access-Control-Allow-Origin": opts.config.profilerOrigin, "Access-Control-Allow-Headers": "*", "Access-Control-Max-Age": "86400" });
      res.end();
      return;
    }

    if (method === "POST") {
      if (path !== "/api/commands") {
        throw new HttpError(404, "not found");
      }
      // Only from the factory's own pages: not from an agent's file (a sandbox's origin is "null") or another site.
      const origin = req.headers.origin;
      if (origin !== undefined && !(URL.canParse(origin) && new URL(origin).host === req.headers.host)) {
        throw new HttpError(403, "commands come from the factory's pages only");
      }
      return postCommands(req, res);
    }
    if (method !== "GET" && method !== "HEAD") {
      throw new HttpError(405, "method not allowed");
    }

    if (path === "/") {
      return send(res, 200, "text/html; charset=utf-8", page(renderOverview(opts.state.listRequests(), ctx(req))));
    }
    if ((m = path.match(/^\/requests\/([^/]+)$/))) {
      const id = decodeURIComponent(m[1]);
      getRequest(id);
      return send(res, 200, "text/html; charset=utf-8", page(renderOverview(opts.state.listRequests(), ctx(req, [id]))));
    }
    if ((m = path.match(/^\/fragments\/requests\/([^/]+)$/))) {
      const id = decodeURIComponent(m[1]);
      const r = getRequest(id);
      return send(res, 200, "text/html; charset=utf-8", renderRequest(r, ctx(req), url.searchParams.get("open") === "1").value);
    }
    if (path === "/fragments/main") {
      return send(res, 200, "text/html; charset=utf-8", renderMain(opts.state.listRequests(), ctx(req, url.searchParams.getAll("open"))).value);
    }
    if (path === "/fragments/strip") {
      return send(res, 200, "text/html; charset=utf-8", renderStrip(opts.state.listRequests(), ctx(req)).value);
    }
    if (path === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      // Reconnection delay for EventSource, e.g. while the server restarts.
      res.write("retry: 2000\n\n");
      // A page connected to an earlier run of the server reloads: its script, style or markup may have changed.
      res.write(`event: hello\ndata: ${JSON.stringify(bootId)}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }
    if ((m = path.match(/^\/api\/requests\/([^/]+)\/profile$/))) {
      const id = decodeURIComponent(m[1]);
      const r = getRequest(id);
      const body = Buffer.from(JSON.stringify(buildRequestProfile(r, opts.state.getEvents?.(id) ?? [], now())), "utf8");
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": body.length,
        "Access-Control-Allow-Origin": opts.config.profilerOrigin,
      });
      res.end(method === "HEAD" ? undefined : body);
      return;
    }
    if ((m = path.match(/^\/api\/requests\/([^/]+)\/jobs\/([^/]+)\/(activity|transcript|profile|log|mach-profile-\d+)$/))) {
      const r = getRequest(decodeURIComponent(m[1]));
      const id = decodeURIComponent(m[2]);
      if (!Object.hasOwn(r.jobs, id)) {
        throw new HttpError(404, `unknown job: ${id}`);
      }
      const job = r.jobs[id];
      const dir = join(opts.config.stateDir, "jobs", id);
      if (m[3] === "log") {
        const part = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : "");
        return send(res, 200, "text/plain; charset=utf-8", `${job.error ? `${job.error}\n\n` : ""}== stderr ==\n${part("err.log")}\n== stdout ==\n${part("out.log")}`);
      }
      if (m[3].startsWith("mach-profile-")) {
        const file = join(dir, `${m[3]}.json`);
        if (!existsSync(file)) {
          throw new HttpError(404, `no ${m[3]} for ${id}`);
        }
        const body = readFileSync(file);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length, "Access-Control-Allow-Origin": opts.config.profilerOrigin });
        res.end(method === "HEAD" ? undefined : body);
        return;
      }
      if (m[3] === "activity") {
        return send(res, 200, "text/html; charset=utf-8", renderActivity(r.id, job, activity(r.id, job, req), ctx(req)).value);
      }
      const transcript = transcriptOf(job);
      if (transcript === undefined) {
        throw new HttpError(404, `no transcript for ${id}`);
      }
      if (m[3] === "transcript") {
        return send(res, 200, "text/plain; charset=utf-8", readFileSync(transcript));
      }
      const profiler = loadProfiler();
      if (!profiler) {
        throw new HttpError(404, "claude-profiler isn't installed");
      }
      const body = Buffer.from(JSON.stringify(profiler.createFirefoxProfile(profiler.readJsonlFile(transcript))), "utf8");
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length, "Access-Control-Allow-Origin": opts.config.profilerOrigin });
      res.end(method === "HEAD" ? undefined : body);
      return;
    }
    // Stack ids are only unique within their request.
    if ((m = path.match(/^\/requests\/([^/]+)\/stacks\/([^/]+)\/review$/))) {
      const request = getRequest(decodeURIComponent(m[1]));
      const id = decodeURIComponent(m[2]);
      const stack = request.stacks[id];
      if (!stack) {
        throw new HttpError(404, `unknown stack: ${id}`);
      }
      const found = { request, stack };
      const base = url.searchParams.get("base") ?? undefined;
      if (base !== undefined && !isRevName(base)) {
        throw new HttpError(400, `not a revision name: ${base}`);
      }
      let page: string;
      try {
        page = await buildStackReview({
          repo: opts.config.firefoxRepo,
          command: opts.config.stackViewerCommand,
          request: found.request,
          stack: found.stack,
          base,
        });
      } catch (e) {
        throw new HttpError(502, errorMessage(e));
      }
      return send(res, 200, "text/html; charset=utf-8", page);
    }
    if ((m = path.match(/^\/requests\/([^/]+)\/patches\/([^/]+)\/view$/))) {
      const request = opts.state.getRequest(decodeURIComponent(m[1]));
      const patch = request?.patches[decodeURIComponent(m[2])];
      if (!request || !patch) {
        throw new HttpError(404, "unknown patch");
      }
      let page: string;
      try {
        page = await buildPatchView({ repo: opts.config.firefoxRepo, command: opts.config.stackViewerCommand, request, patch });
      } catch (e) {
        throw new HttpError(502, errorMessage(e));
      }
      return send(res, 200, "text/html; charset=utf-8", page);
    }
    // A group's DEBUG commits, waiting to go to try on top of the stack.
    if ((m = path.match(/^\/requests\/([^/]+)\/items\/([^/]+)\/debug$/))) {
      const request = opts.state.getRequest(decodeURIComponent(m[1]));
      const item = request?.items[decodeURIComponent(m[2])];
      const last = item?.lastReport;
      const commits = (last?.report as { commits?: string[] } | undefined)?.commits ?? [];
      if (!request || !last || commits.length === 0) {
        throw new HttpError(404, "no DEBUG commits");
      }
      let page: string;
      try {
        page = await buildPushView({ repo: opts.config.firefoxRepo, command: opts.config.stackViewerCommand, cwd: request.jobs[last.job].cwd, commits: [...commits].reverse() });
      } catch (e) {
        throw new HttpError(502, errorMessage(e));
      }
      return send(res, 200, "text/html; charset=utf-8", page);
    }
    if ((m = path.match(/^\/requests\/([^/]+)\/pushes\/([^/]+)\/view$/))) {
      const { dry, d } = pushDryRun(m[1], m[2]);
      if (d.commits.length === 0) {
        throw new HttpError(404, "this push carries no commits");
      }
      let page: string;
      try {
        page = await buildPushView({ repo: opts.config.firefoxRepo, command: opts.config.stackViewerCommand, cwd: dry.cwd, commits: d.commits });
      } catch (e) {
        throw new HttpError(502, errorMessage(e));
      }
      return send(res, 200, "text/html; charset=utf-8", page);
    }
    if ((m = path.match(/^\/api\/requests\/([^/]+)\/pushes\/([^/]+)\/tasks$/))) {
      const { dry, d } = pushDryRun(m[1], m[2]);
      // Dry runs from before jobs were recorded: from the worktree's task set now, once.
      if (!d.jobs) {
        if (!pushJobs.has(dry.job)) {
          pushJobs.set(dry.job, dryRunJobs(dry.cwd, d.command.slice(2), d.tryTaskConfig, opts.mozbuildStateDir));
        }
        d.jobs = pushJobs.get(dry.job);
      }
      // What it would push, newest first: read from the worktree, which still has the commits.
      if (!pushCommits.has(dry.job)) {
        const log = d.commits.length ? spawnSync("git", ["log", "--no-walk=unsorted", "--format=%H%x09%s", ...d.commits], { cwd: dry.cwd, encoding: "utf8" }) : undefined;
        pushCommits.set(dry.job, log?.status === 0 ? log.stdout.split("\n").filter(Boolean).map((l) => ({ sha: l.slice(0, 40), subject: l.slice(41) })) : d.commits.map((sha) => ({ sha, subject: "" })));
      }
      return send(res, 200, "text/html; charset=utf-8", pushTasks(d, pushCommits.get(dry.job)!).value);
    }
    if ((m = path.match(/^\/requests\/([^/]+)\/items\/([^/]+)\/files\/([a-z]+)$/))) {
      const request = opts.state.getRequest(decodeURIComponent(m[1]));
      const item = request?.items[decodeURIComponent(m[2])];
      const which = m[3] as AgentFile;
      const file = request && item && AGENT_FILES.includes(which) ? agentFilePath(request, item, which, opts.config) : undefined;
      if (!request || !item || !file) {
        throw new HttpError(404, "no such file");
      }
      let page: string;
      try {
        page = await renderAgentFile({
          mdViewer: opts.config.mdViewerCommand ?? ["md-viewer"],
          diffViewer: opts.config.diffViewerCommand ?? ["diff-viewer"],
          path: file,
          title: `${which}: ${item.group.tests.join(", ")}`,
        });
      } catch (e) {
        throw new HttpError(502, errorMessage(e));
      }
      res.setHeader("Content-Security-Policy", AGENT_FILE_CSP);
      return send(res, 200, "text/html; charset=utf-8", page);
    }
    const file = STATIC[path];
    if (file) {
      return send(res, 200, file.type, readFileSync(join(import.meta.dirname, file.file)));
    }
    throw new HttpError(404, "not found");
  }

  async function postCommands(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Commands include shell commands, so another site's page must not be able to
    // post a form here.
    const origin = req.headers.origin;
    if (req.headers["sec-fetch-site"] === "cross-site" || (origin !== undefined && hostOf(origin) !== req.headers.host?.toLowerCase())) {
      throw new HttpError(403, "cross-origin command refused");
    }
    const body = await readBody(req);
    const type = (req.headers["content-type"] ?? "").split(";")[0].trim();
    let inputs: unknown[];
    let back = "/";
    if (type === "application/json") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new HttpError(400, "invalid JSON");
      }
      inputs = Array.isArray(parsed) ? parsed : [parsed];
    } else if (type === "application/x-www-form-urlencoded") {
      const form = new URLSearchParams(body);
      inputs = commandsFromForm(form);
      const b = form.get("back");
      // Only local paths, so the redirect can't send you elsewhere.
      if (b && b.startsWith("/") && !b.startsWith("//")) {
        back = b;
      }
    } else {
      throw new HttpError(415, "send application/json or a form");
    }
    if (!inputs.length) {
      throw new HttpError(400, "no command");
    }
    // All or nothing: a recovery plan's checked commands go in together.
    const commands: CommandInput[] = [];
    for (const input of inputs) {
      const v = validateCommand(input, (id) => opts.state.getRequest(id));
      if (!v.ok) {
        throw new HttpError(400, v.error);
      }
      commands.push(v.command);
    }
    for (const c of commands) {
      opts.sink.append(c);
    }
    if (wantsJson(req)) {
      send(res, 200, "application/json", JSON.stringify({ ok: true, appended: commands.length }));
    } else {
      res.writeHead(303, { Location: back });
      res.end();
    }
  }

  return factoryServer;
}

function wantsJson(req: IncomingMessage): boolean {
  return (req.headers.accept ?? "").includes("application/json") || (req.headers["content-type"] ?? "").startsWith("application/json");
}

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null; // "null", from sandboxed or opaque origins
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  const buf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  res.writeHead(status, { "Content-Type": type, "Content-Length": buf.length, "Cache-Control": "no-store" });
  res.end(res.req.method === "HEAD" ? undefined : buf);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, "body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
