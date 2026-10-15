import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { git } from "./git.ts";

// Small throwaway git repos for the stack tests.

export interface TestRepo {
  dir: string;
  git(args: string[]): Promise<string>;
  // Writes the files (null deletes) and commits them on the current HEAD; returns the new sha.
  commit(files: Record<string, string | null>, message: string): Promise<string>;
  cleanup(): void;
}

export async function makeRepo(): Promise<TestRepo> {
  const dir = mkdtempSync(join(tmpdir(), "stack-test-"));
  const g = (args: string[]) => git(dir, args);
  await g(["init", "-q", "-b", "main"]);
  await g(["config", "user.name", "Test"]);
  await g(["config", "user.email", "test@example.com"]);
  await g(["config", "commit.gpgsign", "false"]);
  return {
    dir,
    git: g,
    async commit(files, message) {
      for (const [path, content] of Object.entries(files)) {
        const full = join(dir, path);
        if (content === null) {
          rmSync(full);
        } else {
          mkdirSync(dirname(full), { recursive: true });
          writeFileSync(full, content);
        }
      }
      await g(["add", "-A"]);
      await git(dir, ["commit", "-q", "--no-verify", "--allow-empty", "-F", "-"], { input: message });
      return (await g(["rev-parse", "HEAD"])).trim();
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// "1\n2\n...\nn\n" with some lines replaced.
export function lines(n: number, changes: Record<number, string> = {}): string {
  return Array.from({ length: n }, (_, i) => changes[i + 1] ?? String(i + 1)).join("\n") + "\n";
}
