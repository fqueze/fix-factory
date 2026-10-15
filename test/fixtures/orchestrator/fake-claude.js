// A stand-in for `claude -p --output-format stream-json`: config.claudeCommand is
// ["node", "fake-claude.js", "<rules.json>"], and the runner appends its flags.
// rules.json: [{"match": "<regex on the prompt>", "report": {...}, "cost": 0.01}], first match wins.
// Each call is appended to <rules.json>.calls.jsonl, so tests can check sessions and prompts.
import { appendFileSync, readFileSync } from "node:fs";

const [rulesFile, ...args] = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const session = flag("--session-id") ?? flag("--resume");
const prompt = readFileSync(0, "utf8");
const rules = JSON.parse(readFileSync(rulesFile, "utf8"));
const rule = rules.find((r) => new RegExp(r.match).test(prompt));
appendFileSync(`${rulesFile}.calls.jsonl`, JSON.stringify({ session, resume: args.includes("--resume"), model: flag("--model"), prompt, cwd: process.cwd() }) + "\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
out({ type: "system", subtype: "init", session_id: session, model: flag("--model") });
if (!rule) {
  out({ type: "result", subtype: "error", is_error: true, session_id: session, result: `no fake rule for: ${prompt.slice(0, 200)}` });
  process.exit(1);
}
out({ type: "assistant", session_id: session, message: { content: [{ type: "text", text: "Done." }] } });
out({
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: session,
  total_cost_usd: rule.cost ?? 0.01,
  duration_ms: 5,
  num_turns: 1,
  result: JSON.stringify(rule.report),
  structured_output: rule.report,
});
