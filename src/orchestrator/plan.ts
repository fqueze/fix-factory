// Job plans: what next() asks for, before the runner turns it into a job. A plan is pure data,
// so next() stays pure: the files an agent or a CLI reads are part of the plan, and the runner
// writes them before starting the job.
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { EventInput } from "../state/events.ts";
import type { FactoryConfig, ItemId, JobId, JobKind, JobPurpose, RequestId } from "../types.ts";

// The job's name is the prompt: its model (prompts/index.json) and its schema (schemas/<name>.json).
// A resumed author keeps the name of its first run, so its report keeps the same schema.
export interface AgentPlan {
  sessionId: string;
  resume: boolean;
  vars?: Record<string, string | number>; // render prompts/<prompt>.md with these
  message?: string; // or send this text instead (resumes)
}

export interface JobPlan {
  purpose: JobPurpose;
  kind: JobKind;
  name: string;
  item?: ItemId;
  cwd: string;
  files?: { path: string; content: string }[];
  cli?: { tool: string; args: string[] }; // tool: "try.ts" (src/cli/try.ts), or "git"
  cmd?: string[]; // run as is: a recovery shell command, or a script job run again
  agent?: AgentPlan;
  priority?: number; // lower starts first; review comments are 0
  startEvents?: EventInput[]; // appended when the job actually starts (not when deferred by a cap)
}

export const REVIEW_PRIORITY = 0;
export const DEFAULT_PRIORITY = 1;

export function requestDir(config: Pick<FactoryConfig, "stateDir">, request: RequestId): string {
  return join(config.stateDir, "requests", request);
}

export function dataPath(config: Pick<FactoryConfig, "stateDir">, request: RequestId, name: string): string {
  return join(requestDir(config, request), "data", name);
}

export function reportPath(config: Pick<FactoryConfig, "stateDir">, request: RequestId, job: JobId): string {
  return join(requestDir(config, request), "reports", `${job}.json`);
}

export function outPath(config: Pick<FactoryConfig, "stateDir">, job: JobId): string {
  return join(config.stateDir, "jobs", job, "out.log");
}

export function artifactsDir(config: Pick<FactoryConfig, "stateDir">): string {
  return join(config.stateDir, "cache", "artifacts");
}

// Session ids are derived from the request and the key, so next() can name the session before
// the job exists and stay deterministic. Formatted as a version 4 UUID, which claude requires.
export function sessionIdFor(request: RequestId, key: string): string {
  const h = createHash("sha256").update(`${request}\n${key}`).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function shortHash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 10);
}

export function slug(text: string): string {
  return text
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}
