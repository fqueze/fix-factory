// What the orchestrator needs from a request's events beyond RequestState (src/state/fold.ts):
// each job's purpose and outcome, every needs-user key ever raised or done, and the try job
// failures. Pure.
import type { Event, ItemId, JobId, JobKind, PushId, RequestStep } from "../types.ts";
import type { JobPurpose } from "../types.ts";

export interface JobRecord {
  job: JobId;
  purpose: JobPurpose;
  kind: JobKind;
  name: string;
  item?: ItemId;
  cwd: string;
  sessionId?: string;
  startedAt: number; // ms
  end?: { exitCode: number; error?: string; at: number };
}

export interface TryFailure {
  push: PushId;
  taskId: string;
  retryId?: number;
  jobName: string;
  platform: string;
}

export interface View {
  jobs: JobRecord[]; // in start order
  byKey: Map<string, JobRecord[]>;
  raised: Map<string, number>; // needs-user key → when it was first raised (ms)
  done: Set<string>; // user-done keys
  stepCount: Map<RequestStep, number>; // step events per step, for redo-step
  itemResets: Map<ItemId, number>; // item-state "not started" events per item, for redo-step on an item
  tryFailures: TryFailure[];
  pushedAt: Map<PushId, number>;
  executed: Set<string>; // command ids with a command-executed event: commands run at least once
}

export function buildView(events: readonly Event[]): View {
  const v: View = { jobs: [], byKey: new Map(), raised: new Map(), done: new Set(), stepCount: new Map(), itemResets: new Map(), tryFailures: [], pushedAt: new Map(), executed: new Set() };
  const byJob = new Map<JobId, JobRecord>();
  for (const e of events) {
    switch (e.type) {
      case "job-started": {
        const purpose = (e as { purpose?: JobPurpose }).purpose ?? { key: `job:${e.job}`, what: "unknown" };
        const r: JobRecord = { job: e.job, purpose, kind: e.kind, name: e.name, item: e.item, cwd: e.cwd, sessionId: e.sessionId, startedAt: Date.parse(e.t) };
        v.jobs.push(r);
        byJob.set(e.job, r);
        const list = v.byKey.get(purpose.key) ?? [];
        list.push(r);
        v.byKey.set(purpose.key, list);
        break;
      }
      case "job-finished": {
        const r = byJob.get(e.job);
        if (r) r.end = { exitCode: e.exitCode, error: e.error, at: Date.parse(e.t) };
        break;
      }
      case "needs-user":
        if (!v.raised.has(e.key)) v.raised.set(e.key, Date.parse(e.t));
        break;
      case "user-done":
        v.done.add(e.key);
        break;
      case "step":
        v.stepCount.set(e.step, (v.stepCount.get(e.step) ?? 0) + 1);
        break;
      case "item-state":
        if (e.state === "not started") v.itemResets.set(e.item, (v.itemResets.get(e.item) ?? 0) + 1);
        break;
      case "try-job-failed":
        v.tryFailures.push({ push: e.push, taskId: e.taskId, retryId: e.retryId, jobName: e.jobName, platform: e.platform });
        break;
      case "command-executed":
        v.executed.add(e.command);
        break;
      case "try-pushed":
        if (!v.pushedAt.has(e.push)) v.pushedAt.set(e.push, Date.parse(e.t));
        break;
    }
  }
  return v;
}

export function succeeded(r: JobRecord): boolean {
  return r.end !== undefined && r.end.exitCode === 0 && r.end.error === undefined;
}
