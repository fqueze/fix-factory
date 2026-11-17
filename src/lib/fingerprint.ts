// A patch version's fingerprint: its code (git patch-id --stable, which a rebase that leaves its context alone keeps)
// and its commit message, less what the factory and moz-phab write in it themselves (the bug number, r=, the
// Differential Revision trailer). What an approval is of.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

export function normalizeMessage(message: string): string {
  const lines = message.replace(/\r\n/g, "\n").trimEnd().split("\n");
  lines[0] = lines[0].replace(/^Bug (\d+|X+) - /i, "Bug - ").replace(/,?\s*r[=?]\S.*$/, "");
  return lines
    .filter((l) => !/^Differential Revision: /.test(l))
    .join("\n")
    .trimEnd();
}

export function fingerprintOf(patchId: string, message: string): string {
  return createHash("sha256").update(`${patchId}\n${normalizeMessage(message)}`).digest("hex").slice(0, 16);
}

// Read with git in the repo (worktrees share its objects); undefined when git can't read the commit. Commits never
// change: each is computed once.
export function fingerprinter(repo: string): (sha: string) => string | undefined {
  const cache = new Map<string, string | undefined>();
  return (sha) => {
    if (!/^[0-9a-f]{7,40}$/.test(sha)) return undefined;
    if (!cache.has(sha)) {
      const show = spawnSync("git", ["show", "--no-color", "--no-ext-diff", sha], { cwd: repo, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
      const msg = spawnSync("git", ["log", "-1", "--format=%B", sha], { cwd: repo, encoding: "utf8" });
      if (show.status !== 0 || msg.status !== 0) {
        cache.set(sha, undefined);
      } else {
        // An empty commit has no patch-id.
        const id = spawnSync("git", ["patch-id", "--stable"], { cwd: repo, input: show.stdout, encoding: "utf8" });
        cache.set(sha, id.status === 0 ? fingerprintOf(id.stdout.split(" ")[0] ?? "", msg.stdout) : undefined);
      }
    }
    return cache.get(sha);
  };
}
