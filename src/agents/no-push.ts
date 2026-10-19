// A PreToolUse hook of every agent the factory starts: refuses Bash commands that push anywhere
// (try, a git or hg remote, Lando). Try pushes are the factory's, and only once you approve them,
// except one you allowed that session (allow-push/<session id> in the state directory, used up here).
// Claude Code passes the tool call as JSON on stdin; exit code 2 blocks it and shows stderr to the agent.
//   node no-push.ts <stateDir>
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export function pushIn(command: string): string | undefined {
  for (const part of command.split(/&&|\|\||[;|\n]/)) {
    const p = part.trim();
    if (/\bmach\s+try\b/.test(p) && !/--no-push\b|--help\b|-h\b/.test(p)) return p;
    if (/\b(push-to-try|lando)\b/.test(p) || /\b(git|hg)\s+push\b/.test(p)) return p;
  }
  return undefined;
}

// Sessions started before the hook was given the state directory: the factory's config has it.
function stateDir(): string {
  if (process.argv[2]) return process.argv[2];
  try {
    return (JSON.parse(readFileSync(join(import.meta.dirname, "../../factory.config.json"), "utf8")) as { stateDir: string }).stateDir;
  } catch {
    return "";
  }
}

if (import.meta.main) {
  const input = JSON.parse(readFileSync(0, "utf8")) as { session_id?: string; tool_input?: { command?: string } };
  const push = pushIn(input.tool_input?.command ?? "");
  const allowed = push && input.session_id && /^[\w-]+$/.test(input.session_id) ? join(stateDir(), "allow-push", input.session_id) : undefined;
  if (allowed && existsSync(allowed)) {
    rmSync(allowed, { force: true });
  } else if (push) {
    process.stderr.write(
      `Blocked: agents never push (${push.slice(0, 200)}). Add --no-push to see what a try push would run. Don't work around a push you need: say so in your report (with the command and why); the user can allow you one push. To reproduce on another platform, read the factory's un-skip push results (fx-tests), or hand back a DEBUG commit with state "needs a try repro".\n`,
    );
    process.exit(2);
  }
}
