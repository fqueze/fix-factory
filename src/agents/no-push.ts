// A PreToolUse hook of every agent the factory starts: refuses Bash commands that push anywhere
// (try, a git or hg remote, Lando, moz-phab). Try pushes are the factory's, and only once you approve them,
// except one try push you allowed that session (allow-push/<session id> in the state directory, used up here).
// Claude Code passes the tool call as JSON on stdin; exit code 2 blocks it and shows stderr to the agent,
// so any error here exits 2 too. A guard against mistakes and easy workarounds, not a sandbox.
//   node no-push.ts <stateDir>
import { readFileSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";

export type Push = { command: string; tryPush: boolean };

// The simple commands of a shell command line, as words: quotes removed, split on ; & | newlines,
// ( ) and backticks. $( ) and backticks inside double quotes are split out as commands of their own.
export function shellCommands(text: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word: string | undefined;
  const endWord = () => {
    if (word !== undefined) words.push(word);
    word = undefined;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      word = (word ?? "") + text.slice(i + 1, end < 0 ? undefined : end);
      i = end < 0 ? text.length : end;
    } else if (c === '"') {
      word ??= "";
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === "\\" && i + 1 < text.length) {
          word += text[++i];
        } else if (text[i] === "`" || text.startsWith("$(", i)) {
          // A substitution: its commands run too.
          let end = i + 1;
          if (text[i] === "`") {
            while (end < text.length && text[end] !== "`") end++;
          } else {
            for (let depth = 0; end < text.length; end++) {
              if (text[end] === "(") depth++;
              else if (text[end] === ")" && --depth === 0) break;
            }
          }
          commands.push(...shellCommands(text.slice(i + (text[i] === "`" ? 1 : 2), end)));
          word += text.slice(i, end + 1);
          i = end;
        } else {
          word += text[i];
        }
      }
    } else if (c === "\\") {
      if (text[i + 1] !== "\n") word = (word ?? "") + (text[i + 1] ?? "");
      i++;
    } else if (/[;&|\n()`]/.test(c) || text.startsWith("$(", i)) {
      endCommand();
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      word = (word ?? "") + c;
    }
  }
  endCommand();
  return commands;
}

// Words that run the command after them.
const PREFIXES = new Set(["{", "!", "if", "then", "else", "elif", "while", "until", "do", "time", "nohup", "exec", "command", "builtin", "env", "sudo", "nice", "xargs", "timeout", "stdbuf"]);
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix"]);
const HG_VALUE_OPTIONS = new Set(["-R", "--repository", "--cwd", "--config", "--encoding", "--encodingmode", "--color", "--pager"]);
const MACH_VALUE_OPTIONS = new Set(["-l", "--log-file", "--settings"]);

// The first word that isn't an option (nor an option's value), from index `from`.
function subcommand(words: string[], from: number, valueOptions: Set<string>): number {
  let i = from;
  while (i < words.length && words[i].startsWith("-")) i += valueOptions.has(words[i]) ? 2 : 1;
  return i;
}

const isTry = (w: string) => /(^|\/)try\/?$/.test(w);

function pushInWords(words: string[]): Push | undefined {
  let i = 0;
  // Skip what runs the command: VAR=value, env -i, timeout -k 5 10…
  let prefixed = false;
  for (; i < words.length; i++) {
    if (PREFIXES.has(words[i])) prefixed = true;
    else if (!/^\w+=/.test(words[i]) && !(prefixed && /^(-|\d)/.test(words[i]))) break;
  }
  if (i >= words.length) return undefined;
  const command = words.slice(i).join(" ");
  const name = basename(words[i]);
  const rest = words.slice(i + 1);
  if (name === "eval") return pushIn(rest.join(" "));
  if (/^(ba|z|da|k)?sh$/.test(name)) {
    const c = rest.findIndex((w) => /^-[a-z]*c[a-z]*$/.test(w));
    return c >= 0 && c + 1 < rest.length ? pushIn(rest[c + 1]) : undefined;
  }
  if (name === "lando" || name === "moz-phab" || name === "push-to-try") return { command, tryPush: name === "push-to-try" };
  if (name === "git" || name === "hg") {
    const options = name === "git" ? GIT_VALUE_OPTIONS : HG_VALUE_OPTIONS;
    // An alias defined on the command line could name push.
    if (rest.some((w, j) => (w === "-c" || w === "--config") && /^alias\..*push/i.test(rest[j + 1] ?? ""))) return { command, tryPush: false };
    const sub = rest[subcommand(rest, 0, options)];
    if (sub === "push" || (name === "git" && sub === "send-pack")) return { command, tryPush: rest.some(isTry) };
    return undefined;
  }
  // mach, ./mach, path/to/mach, python3 mach
  let mach = name === "mach" ? 0 : -1;
  if (/^python[\d.]*$/.test(name)) {
    const j = subcommand(rest, 0, new Set());
    if (basename(rest[j] ?? "") === "mach") mach = j + 1;
  }
  if (mach < 0) return undefined;
  const j = subcommand(rest, mach, MACH_VALUE_OPTIONS);
  if (rest[j] === "push-to-try") return { command, tryPush: true };
  if (rest[j] !== "try") return undefined;
  // After a "--", argparse takes everything as paths.
  const args = rest.slice(j + 1);
  const options = args.includes("--") ? args.slice(0, args.indexOf("--")) : args;
  if (options.includes("--no-push") || options.includes("--help") || options.includes("-h")) return undefined;
  return { command, tryPush: true };
}

export function pushIn(text: string): Push | undefined {
  for (const words of shellCommands(text)) {
    const push = pushInWords(words);
    if (push) return push;
  }
  return undefined;
}

// The one push you allowed that session, used up: only the run that removes the file gets it.
function useAllowance(stateDir: string, session: string | undefined): boolean {
  if (!session || !/^[\w-]+$/.test(session)) return false;
  try {
    unlinkSync(join(stateDir, "allow-push", session));
    return true;
  } catch {
    return false;
  }
}

function main(): void {
  const stateDir = process.argv[2];
  if (!stateDir) throw new Error("no state directory given");
  const input = JSON.parse(readFileSync(0, "utf8")) as { session_id?: string; tool_input?: { command?: string } };
  const push = pushIn(input.tool_input?.command ?? "");
  if (!push || (push.tryPush && useAllowance(stateDir, input.session_id))) return;
  process.stderr.write(
    `Blocked: agents never push (${push.command.slice(0, 200)}). Add --no-push to see what a try push would run. Don't work around a push you need: put what it should run and why in your report's \`tryRequest\`; the factory plans it, the user approves it, and you're resumed with the results. To reproduce on another platform, read the factory's un-skip push results (fx-tests), or hand back a DEBUG commit with state "needs a try repro".\n`,
  );
  process.exit(2);
}

if (import.meta.main) {
  try {
    main();
  } catch (e) {
    process.stderr.write(`Blocked: the no-push hook failed (${e instanceof Error ? e.message : String(e)}).\n`);
    process.exit(2);
  }
}
