// Messages you send a running agent: the factory appends them to its session's inbox (inbox/<session>.jsonl in the
// state directory); this hook, run by the agent's Claude Code after each tool call, hands it those it hasn't had
// yet and records when (inbox/<session>.delivered). A message an agent never got (its run ended first) is sent by
// resuming its session.
//
// As a hook: node inbox.ts <stateDir>, the hook's JSON input on stdin.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface InboxMessage {
  id: string; // the command's id
  text: string;
  t: string; // when you sent it
}

const dir = (stateDir: string) => join(stateDir, "inbox");
const inboxFile = (stateDir: string, session: string) => join(dir(stateDir), `${session}.jsonl`);
const deliveredFile = (stateDir: string, session: string) => join(dir(stateDir), `${session}.delivered`);

const lines = <T>(path: string): T[] =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as T)
    : [];

export function sendToInbox(stateDir: string, session: string, m: InboxMessage): void {
  mkdirSync(dir(stateDir), { recursive: true });
  appendFileSync(inboxFile(stateDir, session), JSON.stringify(m) + "\n");
}

// When each message was handed to the agent, by id.
export function delivered(stateDir: string, session: string): Map<string, string> {
  return new Map(lines<{ id: string; at: string }>(deliveredFile(stateDir, session)).map((d) => [d.id, d.at]));
}

// The messages not handed over yet, now marked as handed over.
export function takeNew(stateDir: string, session: string, now = new Date()): InboxMessage[] {
  const had = delivered(stateDir, session);
  const fresh = lines<InboxMessage>(inboxFile(stateDir, session)).filter((m) => !had.has(m.id));
  for (const m of fresh) appendFileSync(deliveredFile(stateDir, session), JSON.stringify({ id: m.id, at: now.toISOString() }) + "\n");
  return fresh;
}

export function hookOutput(messages: InboxMessage[]): string | undefined {
  if (!messages.length) return undefined;
  const text = messages.map((m) => `A message from the user, sent while you were working:\n${m.text}`).join("\n\n");
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: `${text}\n\nTake it into account in what you do next; if it changes your fix, amend your commit. If you think it is wrong, say why in your report's \`disagreement\` rather than doing it.` } });
}

if (import.meta.main) {
  // A failing hook mustn't get in the agent's way: the message is then sent by resuming it.
  try {
    const input = JSON.parse(readFileSync(0, "utf8")) as { session_id?: string };
    const out = input.session_id ? hookOutput(takeNew(process.argv[2], input.session_id)) : undefined;
    if (out) process.stdout.write(out + "\n");
  } catch {}
}
