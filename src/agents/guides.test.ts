import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { guidesOf, withGuides } from "./guides.ts";
import type { JobPlan } from "../orchestrator/plan.ts";

const plan = (agent: JobPlan["agent"]): JobPlan => ({ purpose: { key: "k", what: "author" }, kind: "agent", name: "investigate-and-fix", cwd: "/w", files: [{ path: "/s/x.json", content: "{}" }], agent });
const guides: Record<string, string> = { "investigate-and-fix": "own rules\n", worktrees: "shared rules\n" };
const template = "Fix {test}. Read {guide} first, then {worktreesGuide}.";

test("a prompt's guides are input files under the request's data dir, their paths in its variables", () => {
  const out = withGuides({ stateDir: "/s" }, "r-1", plan({ sessionId: "a", resume: false, vars: { test: "t" } }), template, (n) => guides[n]);
  const vars = out.agent!.vars!;
  assert.match(String(vars.guide), /^\/s\/requests\/r-1\/data\/guides\/investigate-and-fix-[0-9a-f]{10}\.md$/);
  assert.match(String(vars.worktreesGuide), /\/guides\/worktrees-[0-9a-f]{10}\.md$/);
  assert.deepEqual(out.files, [{ path: "/s/x.json", content: "{}" }, { path: vars.guide, content: "own rules\n" }, { path: vars.worktreesGuide, content: "shared rules\n" }]);
});

test("a changed guide gets a new file: a running session's never changes under it", () => {
  const a = withGuides({ stateDir: "/s" }, "r-1", plan({ sessionId: "a", resume: false, vars: {} }), template, (n) => guides[n]);
  const b = withGuides({ stateDir: "/s" }, "r-1", plan({ sessionId: "a", resume: false, vars: {} }), template, (n) => `${guides[n]}more\n`);
  assert.notEqual(a.agent!.vars!.guide, b.agent!.vars!.guide);
});

test("a resume with a message, and a plan run again with its guides, are left as they are", () => {
  const resume = plan({ sessionId: "a", resume: true, message: "go on" });
  assert.equal(withGuides({ stateDir: "/s" }, "r-1", resume, template, (n) => guides[n]), resume);
  const again = withGuides({ stateDir: "/s" }, "r-1", plan({ sessionId: "a", resume: false, vars: {} }), template, (n) => guides[n]);
  assert.equal(withGuides({ stateDir: "/s" }, "r-1", again, template, () => assert.fail("read again")), again);
});

test("every guide a prompt names exists", () => {
  const dir = fileURLToPath(new URL("../../prompts/", import.meta.url));
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    for (const name of guidesOf(f.slice(0, -3), readFileSync(dir + f, "utf8")).values()) readFileSync(`${dir}guides/${name}.md`, "utf8");
  }
});
