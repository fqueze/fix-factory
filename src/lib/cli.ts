import { parseArgs, type ParseArgsConfig } from "node:util";

// Common entry point for the CLIs in src/cli/: one JSON document on stdout,
// logs on stderr, exit code 1 with {"error": "..."} on failure.
export type Subcommand = (positionals: string[], values: Record<string, string | boolean | string[] | undefined>) => Promise<unknown>;

export async function runCli(subcommands: Record<string, Subcommand>, options: ParseArgsConfig["options"] = {}): Promise<void> {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    options: { "dry-run": { type: "boolean" }, ...options },
    allowPositionals: true,
  });
  const [name, ...rest] = positionals;
  const sub = name ? subcommands[name] : undefined;
  if (!sub) {
    process.stderr.write(`usage: ${Object.keys(subcommands).join(" | ")}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    const out = await sub(rest, values as Record<string, string | boolean | string[] | undefined>);
    if (out !== undefined) {
      process.stdout.write(JSON.stringify(out) + "\n");
    }
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) + "\n");
    process.exitCode = 1;
  }
}

export function log(...args: unknown[]): void {
  process.stderr.write(args.map(String).join(" ") + "\n");
}
