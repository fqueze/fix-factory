import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentCommandProblem, onPath } from "./agent-command.ts";

describe("agentCommandProblem", () => {
  it("is nothing when the program is on the PATH, and says how to install mozsb when it isn't", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-command-"));
    try {
      writeFileSync(join(dir, "mozsb"), "#!/bin/sh\n", { mode: 0o755 });
      assert.equal(onPath("mozsb", dir), true);
      assert.equal(agentCommandProblem(["mozsb", "claude"], ["/build/firefox"], dir), undefined);
      const problem = agentCommandProblem(["mozsb", "claude"], ["/build/firefox", "/build/worktrees"], "/nowhere")!;
      assert.match(problem, /git clone https:\/\/github.com\/padenot\/moz-local-sandbox && cd moz-local-sandbox && \.\/install\.sh/);
      assert.match(problem, /SRC = \/build\/firefox\n {2}SRC = \/build\/worktrees/);
      assert.match(agentCommandProblem(["claude"], [], "/nowhere")!, /^claude, the program agents run with/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
