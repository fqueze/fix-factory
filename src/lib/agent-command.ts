// Whether the command agents run with (config claudeCommand) can start: its program found on the PATH. The orchestrator
// refuses to start without it, saying how to get it, rather than failing every agent it starts.
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

const MOZSB_REPO = "https://github.com/padenot/moz-local-sandbox";

export function onPath(program: string, path = process.env.PATH ?? ""): boolean {
  const runnable = (file: string) => {
    try {
      accessSync(file, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  return program.includes("/") ? runnable(program) : path.split(delimiter).some((dir) => dir !== "" && runnable(join(dir, program)));
}

// Why agents can't start, or undefined when they can. dirs: what mozsb's sandbox must let them write.
export function agentCommandProblem(claudeCommand: string[], dirs: string[], path?: string): string | undefined {
  const [program] = claudeCommand;
  if (onPath(program, path)) return undefined;
  if (program === "mozsb") {
    return [
      `mozsb, the sandbox agents run in (claudeCommand ${JSON.stringify(claudeCommand)}), isn't on the PATH. Install it:`,
      `  git clone ${MOZSB_REPO} && cd moz-local-sandbox && ./install.sh`,
      "It needs bwrap (your distribution's bubblewrap package). Then give its sandbox these source roots, in",
      "~/.config/mozsb/config (see its README, Configuration):",
      ...dirs.map((d) => `  SRC = ${d}`),
      "Install it outside them: mozsb refuses to run from a folder its sandbox can write to.",
    ].join("\n");
  }
  return `${program}, the program agents run with (claudeCommand ${JSON.stringify(claudeCommand)}), isn't on the PATH.`;
}
