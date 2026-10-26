// What a session of your own needs to take groups over: everything the factory knows about them, as one file
// write-hand-off turns into a prompt. Pure, apart from the home directory transcripts live in.
import { homedir } from "node:os";
import { basename } from "node:path";
import { transcriptPath } from "../agents/run.ts";
import { keptDir } from "../lib/kept.ts";
import type { FactoryConfig, ItemId, RequestState } from "../types.ts";
import { reportPath } from "./plan.ts";

export function handOffReferences(config: Pick<FactoryConfig, "stateDir" | "firefoxRepo">, s: RequestState, items: ItemId[]): unknown {
  return {
    request: { id: s.id, kind: s.kind, text: s.text, config: s.config },
    firefoxRepo: config.firefoxRepo,
    groups: items.map((id) => {
      const item = s.items[id];
      const jobs = item.jobs.map((j) => s.jobs[j]).filter((j) => j !== undefined);
      const worktrees = [...new Set(jobs.filter((j) => j.name === "investigate-and-fix").map((j) => j.cwd))];
      return {
        id,
        tests: item.group.tests,
        failure: item.group.message,
        configs: item.group.configs,
        state: item.state,
        detail: item.detail,
        investigation: item.investigation,
        // A removed worktree's artifacts are kept, and its commits under refs/fix-factory/<its name>/ in firefoxRepo.
        worktrees: worktrees.map((path) => ({ path, keptArtifacts: keptDir(config.stateDir, basename(path)), keptCommits: `refs/fix-factory/${basename(path)}/` })),
        patches: Object.values(s.patches)
          .filter((p) => p.item === id)
          .map((p) => ({ title: p.title, sha: p.sha, worktree: p.worktree, bug: p.bug, bugDraft: p.bugDraft, revision: p.revision, testPlan: p.testPlan })),
        sessions: jobs
          .filter((j) => j.kind === "agent" && j.sessionId)
          .map((j) => ({
            name: j.name,
            why: j.purpose?.reason,
            startedAt: j.startedAt,
            outcome: j.outcome,
            error: j.error,
            sessionId: j.sessionId,
            cwd: j.cwd,
            transcript: transcriptPath(homedir(), j.cwd, j.sessionId!),
            report: reportPath(config, s.id, j.job),
          })),
      };
    }),
    // The request's try pushes: stack pushes carry every group's patches, debug pushes some groups' DEBUG commits.
    pushes: Object.values(s.pushes)
      .filter((p) => p.rev)
      .map((p) => ({
        purpose: p.purpose,
        scope: p.scope,
        url: p.url,
        rev: p.rev,
        command: p.command.join(" "),
        result: p.result,
        summary: p.summary,
        // Its triage, for these groups' tests and patches.
        analysis: p.analysis?.filter((c) => items.some((id) => (c.test !== undefined && s.items[id].group.tests.some((t) => c.test!.endsWith(t) || t.endsWith(c.test!))) || (c.patch !== undefined && s.patches[c.patch]?.item === id))),
      })),
  };
}
