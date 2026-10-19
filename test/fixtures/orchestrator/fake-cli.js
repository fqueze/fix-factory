// A stand-in for the factory's CLIs (and git): the orchestrator's cliCommand is
// (tool) => ["node", "fake-cli.js", "<rules.json>", tool], and it appends the arguments.
// rules.json: [{"match": "<regex on 'tool arg arg…'>", "out": <JSON, or a string printed as is>,
//   "lines": [<JSON lines, for try.ts watch>], "exit": 0, "mkdir": "<dir to create>", "write": {"<path>": "<text>"},
//   "stderr": "<text>"}], first match wins.
// In strings, $1…$9 are the regex groups and $WORKTREES is the FAKE_WORKTREES environment variable.
// Each call is appended to <rules.json>.calls.jsonl.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const [rulesFile, ...argv] = process.argv.slice(2);
const line = argv.join(" ");
appendFileSync(`${rulesFile}.calls.jsonl`, JSON.stringify({ argv, cwd: process.cwd() }) + "\n");
const rules = JSON.parse(readFileSync(rulesFile, "utf8"));
for (const rule of rules) {
  const m = line.match(new RegExp(rule.match));
  if (!m) continue;
  const fill = (s) => s.replace(/\$(\d)/g, (_, n) => m[Number(n)] ?? "").replace(/\$WORKTREES/g, process.env.FAKE_WORKTREES ?? "");
  const deep = (v) => (typeof v === "string" ? fill(v) : Array.isArray(v) ? v.map(deep) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v);
  if (rule.mkdir) mkdirSync(fill(rule.mkdir), { recursive: true });
  for (const [path, text] of Object.entries(rule.write ?? {})) writeFileSync(fill(path), fill(text));
  if (rule.stderr) process.stderr.write(fill(rule.stderr));
  for (const l of rule.lines ?? []) process.stdout.write(JSON.stringify(deep(l)) + "\n");
  if (rule.out !== undefined) process.stdout.write(typeof rule.out === "string" ? fill(rule.out) : JSON.stringify(deep(rule.out)) + "\n");
  process.exit(rule.exit ?? 0);
}
process.stdout.write(JSON.stringify({ error: `no fake rule for: ${line}` }) + "\n");
process.exit(1);
