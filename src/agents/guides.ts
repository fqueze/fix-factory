// Guides: the long part of a prompt, in prompts/guides/<name>.md. A prompt names one by a placeholder: {guide} is its
// own (prompts/guides/<prompt>.md), {<name>Guide} another one ({worktreesGuide}: prompts/guides/worktrees.md). Agents
// can't be assumed to read the factory's repo: each guide a prompt names goes in its job plan as an input file under
// the request's data dir, and the placeholder holds that file's path.
import { createHash } from "node:crypto";
import type { FactoryConfig, RequestId } from "../types.ts";
import type { JobPlan } from "../orchestrator/plan.ts";
import { dataPath } from "../orchestrator/plan.ts";

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

// The guides a prompt names: placeholder → guide name.
export function guidesOf(prompt: string, template: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of template.matchAll(PLACEHOLDER)) {
    if (m[1] === "guide") out.set(m[1], prompt);
    else if (m[1].endsWith("Guide")) out.set(m[1], m[1].slice(0, -"Guide".length));
  }
  return out;
}

// The plan with the guides its prompt names, as input files and the variables holding their paths. A file is named by
// its content, so a session's guide never changes under it. A plan already given its guides (one run again from its
// plan.json) is left as it is, and so is a resume with a message: a session gets its guides with its prompt.
export function withGuides(config: Pick<FactoryConfig, "stateDir">, request: RequestId, plan: JobPlan, template: string, readGuide: (name: string) => string): JobPlan {
  const vars = plan.agent?.vars;
  if (!vars) return plan;
  const files = [...(plan.files ?? [])];
  const added: Record<string, string> = {};
  for (const [placeholder, name] of guidesOf(plan.name, template)) {
    if (Object.hasOwn(vars, placeholder)) continue;
    const content = readGuide(name);
    const path = dataPath(config, request, `guides/${name}-${createHash("sha256").update(content).digest("hex").slice(0, 10)}.md`);
    files.push({ path, content });
    added[placeholder] = path;
  }
  if (!Object.keys(added).length) return plan;
  return { ...plan, files, agent: { ...plan.agent!, vars: { ...vars, ...added } } };
}
