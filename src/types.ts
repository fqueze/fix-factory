// Shared contract between the orchestrator, the web server, the CLIs and the agent runner.
// Only add fields or union members; never rename or remove (see docs/CONTRACTS.md).

export type Iso = string; // ISO 8601 timestamp
export type RequestId = string; // e.g. "r-20261015-xpcshell-cwd"
export type ItemId = string; // work item, unique within a request
export type JobId = string; // unique across the factory
export type PatchId = string; // stable across rewrites; the sha changes, the id doesn't
export type PushId = string;

// ---------------------------------------------------------------------------
// Configuration: factory.config.json

export interface FactoryConfig {
  port: number; // web server, listens on all interfaces
  allowedHosts?: string[]; // extra Host header values accepted besides IPs, localhost and this machine's name
  stateDir: string; // commands.jsonl, requests/, jobs/, feedback/, cache/
  firefoxRepo: string; // main checkout; worktrees are created next to it, never inside
  worktreesDir: string;
  baseRef: string; // central-based ref worktrees and stacks start from, e.g. "origin/main"
  phabPollHours?: number; // default 3, only while you are present
  claudeCommand: string[]; // e.g. ["mozsb", "claude"]; the runner appends -p and its flags
  stackViewerCommand: string[]; // e.g. ["stack-viewer"]
  profilerOrigin: string; // e.g. "http://localhost:4242" (a local profiler front end), for request profiles
  maxAgents: number;
  maxBuilds: number;
  dryRun: boolean; // refuse every external side effect (try, Phabricator, Bugzilla, agents)
}

// ---------------------------------------------------------------------------
// Work item states (from orchestrate-parallel-fixes, plus factory steps).

export type ItemState =
  | "not started"
  | "waiting for a build slot"
  | "investigating"
  | "fix verified locally"
  | "in critical review"
  | "review findings"
  | "reviewed"
  | "in stack"
  | "in try"
  | "waiting for review"
  | "addressing review comments"
  | "blocked"
  // terminal
  | "fixed"
  | "left as-is"
  | "handed back"
  | "landed";

export type RequestStep =
  | "request"
  | "first signal"
  | "work list"
  | "investigate and fix"
  | "stack"
  | "verify on try"
  | "meta bug"
  | "submit"
  | "review comments"
  | "landing"
  | "done";

// ---------------------------------------------------------------------------
// events.jsonl: one file per request, append-only, written by the orchestrator only.

interface EventBase {
  v: 1;
  t: Iso;
  request: RequestId;
}

// "unrouted": typed in the main box, and route-request hasn't said what it is yet.
export type RequestKind = "burndown" | "try-push" | "unrouted";

export interface FailureGroup {
  message: string; // the shared specific failure message, or the generic one for a single test
  tests: string[];
  configs: string[];
  ratePerWeek?: number; // value, for stack ordering
  taskIds?: string[];
}

export interface BugDraft {
  product: string;
  component: string;
  summary: string;
  description: string;
  blocks?: number[];
  bugType?: "defect" | "task" | "enhancement";
  keywords?: string[]; // e.g. ["meta"]
}

export interface Dep {
  patch: PatchId; // the dependent patch
  needs: PatchId | string; // a patch id, or free text for something outside the stack
  kind: "hard" | "soft";
  reason: string;
  source: "agent" | "textual" | "reviewer" | "user";
}

export interface ReviewerStatus {
  name: string; // "mconley", "#home-newtab-reviewers"
  status: "accepted" | "blocking" | "pending" | "resigned";
}

export interface InlineComment {
  id: number; // Phabricator inline id, for D…#inline-N links
  author: string;
  file?: string;
  line?: number;
  text: string;
  suggestion?: string; // "suggest edit" replacement text
  done: boolean;
  kind?: "suggested edit" | "nit" | "question" | "change request";
}

export type JobKind = "script" | "agent" | "build" | "try-watch";

export type Event =
  | (EventBase & { type: "request-created"; kind: RequestKind; text: string; folder?: string; rev?: string; command?: string })
  | (EventBase & { type: "request-routed"; kind: Exclude<RequestKind, "unrouted">; folder?: string; rev?: string })
  | (EventBase & { type: "request-forwarded"; to: RequestId })
  | (EventBase & { type: "request-superseded"; by: RequestId })
  | (EventBase & { type: "config-set"; config: Record<string, unknown> })
  | (EventBase & { type: "step"; step: RequestStep })
  | (EventBase & { type: "item-created"; item: ItemId; folder: string; group: FailureGroup })
  | (EventBase & { type: "item-state"; item: ItemId; state: ItemState; detail?: string })
  | (EventBase & {
      type: "job-started";
      job: JobId;
      item?: ItemId;
      kind: JobKind;
      name: string; // "failures.ts try-table", or a prompt name such as "investigate-and-fix"
      pid: number;
      pidStartTime: number; // from /proc/<pid>/stat, to detect pid reuse
      cmd: string[];
      cwd: string;
      codeVersion: string; // git sha of the factory release
      model?: string;
      sessionId?: string;
      promptVersion?: string; // git blob sha of the prompt file
      purpose?: JobPurpose;
    })
  | (EventBase & { type: "job-finished"; job: JobId; exitCode: number; durationMs: number; output?: unknown; costUsd?: number; error?: string; machProfiles?: number })
  | (EventBase & { type: "agent-report"; job: JobId; item?: ItemId; prompt: string; report: unknown })
  | (EventBase & {
      type: "patch";
      patch: PatchId;
      item?: ItemId;
      sha: string;
      worktree: string;
      title: string; // first line of the commit message
      bug: number | null; // null while the message says Bug XXXXXXX
      bugDraft?: BugDraft;
      revision?: number; // D-number once submitted
      effort?: number; // 1-5
      testOnly?: boolean;
      interdiffFile?: string; // diff against the previously submitted version, relative to stateDir
    })
  | (EventBase & { type: "dep"; dep: Dep })
  | (EventBase & { type: "dep-removed"; patch: PatchId; needs: PatchId | string })
  | (EventBase & { type: "stack"; stack: string; folder: string; branch: string; worktree: string; base?: string; order: PatchId[]; summary?: string })
  | (EventBase & { type: "meta-bug"; bug: number | null; draft?: BugDraft })
  | (EventBase & { type: "try-planned"; push: PushId; purpose: string; command: string[]; taskCount?: number })
  | (EventBase & { type: "try-declined"; push: PushId; text: string; by?: "factory" }) // you said no, or the factory withdrew it
  | (EventBase & { type: "try-pushed"; push: PushId; rev: string; url: string })
  | (EventBase & { type: "try-progress"; push: PushId; done: number; total: number; failures: number })
  | (EventBase & { type: "try-job-failed"; push: PushId; taskId: string; retryId?: number; jobName: string; platform: string; tier?: number; result: string })
  | (EventBase & { type: "try-finished"; push: PushId; result: "green" | "failures"; summary: string })
  | (EventBase & { type: "review-status"; patch: PatchId; revision: number; status: string; reviewers: ReviewerStatus[]; comments: InlineComment[] })
  | (EventBase & { type: "reply-draft"; patch: PatchId; commentId: number; text: string })
  | (EventBase & { type: "needs-user"; key: string; action: string; detail: string; item?: ItemId; patch?: PatchId; push?: PushId; stack?: string; job?: JobId })
  | (EventBase & { type: "user-done"; key: string }) // clears a needs-user with the same key
  | (EventBase & { type: "command-executed"; command: string; ok: boolean; detail?: string; cmd?: Command["cmd"]; item?: ItemId; job?: JobId })
  | (EventBase & { type: "recovery-plan"; job: JobId; text: string; plan: PlannedCommand[]; cannotDo: string[]; questions: string[] })
  | (EventBase & { type: "note"; text: string });

export type EventType = Event["type"];

// ---------------------------------------------------------------------------
// commands.jsonl: one file for the factory, append-only, written by the web server
// (your clicks) and by the orchestrator when you approve a recovery plan.

interface CommandBase {
  v: 1;
  id: string;
  t: Iso;
  request?: RequestId;
}

export type Command =
  | (CommandBase & { cmd: "approve-push"; push: PushId })
  | (CommandBase & { cmd: "decline-push"; push: PushId; text: string })
  | (CommandBase & { cmd: "set-bug"; patch: PatchId; bug: number })
  | (CommandBase & { cmd: "comment-bug-draft"; patch: PatchId | "meta"; text: string })
  | (CommandBase & { cmd: "stack-comments"; stack: string; comments: { patch: PatchId; text: string }[] })
  | (CommandBase & { cmd: "take-it" | "hand-back"; item: ItemId })
  | (CommandBase & { cmd: "comment-fix"; patch: PatchId; text: string })
  | (CommandBase & { cmd: "tell-factory"; text: string })
  | (CommandBase & { cmd: "reply-recovery"; job: JobId; text: string })
  | (CommandBase & { cmd: "start-now" })
  | (CommandBase & { cmd: "presence"; visible: boolean }) // sent by a visible page, see docs/ORCHESTRATOR.md
  // The ways out of a ⚑, from its buttons.
  | (CommandBase & { cmd: "accept-review"; item: ItemId }) // the item is reviewed despite its critical review findings
  | (CommandBase & { cmd: "allow-push"; item: ItemId }) // its author's session may make one try push
  | (CommandBase & { cmd: "continue"; item: ItemId; text: string }) // resumes the item's author session with your message
  | (CommandBase & { cmd: "retry"; job: JobId }) // what retry-job does, except for try pushes
  | (CommandBase & { cmd: "stop"; job: JobId }) // cancels a running job; its item waits for a continue
  | (CommandBase & { cmd: "dismiss"; key: string }) // clears a ⚑: a needs-user key, or a refused command's key
  // Recovery commands: proposed by recover.md, executed after your approval.
  | (CommandBase & PlannedCommand);

export type PlannedCommand =
  | { cmd: "retry-job"; job: JobId; reason: string }
  | { cmd: "cancel-job"; job: JobId; reason: string }
  | { cmd: "resume-agent"; item: ItemId; message: string; reason: string }
  | { cmd: "start-agent"; item: ItemId; prompt: string; reason: string } // prompt: instructions for a fresh investigate-and-fix run
  | { cmd: "set-state"; item: ItemId; state: ItemState; reason: string }
  | { cmd: "redo-step"; item?: ItemId; step: RequestStep; reason: string }
  | { cmd: "edit-config"; config: Record<string, unknown>; reason: string }
  | { cmd: "shell"; cwd: string; command: string; reason: string };

// ---------------------------------------------------------------------------
// Agent reports: the structured_output of each prompt. The JSON schemas in
// schemas/<prompt>.json must match these.

export interface Feedback {
  target: "fx-tests" | "profiler-cli" | "searchfox-cli" | "factory" | "inputs";
  text: string;
}

export interface InvestigateReport {
  state: "fix verified locally" | "left as-is" | "handed back" | "blocked";
  summary: string; // one line, shown on the status page
  cause: string;
  verification: string;
  commits: string[]; // shas in the agent's worktree, oldest first
  bugDraft?: BugDraft; // when the fix needs its own bug
  landsAfter: { what: string; reason: string }[];
  feedback: Feedback[];
}

export interface ReviewPatchReport {
  verdict: "ok" | "findings";
  findings: { severity: "must-fix" | "nit"; file?: string; line?: number; text: string }[];
  feedback: Feedback[];
}

export interface RecoverReport {
  plan: PlannedCommand[];
  cannotDo: string[];
  questions: string[];
  feedback: Feedback[];
}

// ---------------------------------------------------------------------------
// Folded state: what src/state/fold.ts computes from a request's events.jsonl.
// The web server renders from this; the orchestrator decides from it.

export interface JobView {
  job: JobId;
  item?: ItemId;
  kind: JobKind;
  name: string;
  cmd: string[];
  cwd: string;
  pid: number;
  pidStartTime: number;
  startedAt: Iso;
  endedAt?: Iso;
  exitCode?: number;
  durationMs?: number;
  costUsd?: number;
  model?: string;
  sessionId?: string;
  error?: string;
  purpose?: JobPurpose; // absent for jobs whose job-started has none
  machProfiles?: number; // resource-usage profiles of the mach builds and test runs it made, kept in its directory
}

export interface ItemView {
  id: ItemId;
  folder: string;
  group: FailureGroup;
  state: ItemState;
  detail?: string;
  jobs: JobId[]; // oldest first
  lastReport?: { prompt: string; report: unknown; job: JobId };
}

export interface PatchView {
  id: PatchId;
  item?: ItemId;
  sha: string;
  worktree: string;
  title: string;
  bug: number | null;
  bugDraft?: BugDraft;
  revision?: number;
  effort?: number;
  testOnly?: boolean;
  interdiffFile?: string;
  deps: Dep[]; // deps where this patch is the dependent one
  review?: { revision: number; status: string; reviewers: ReviewerStatus[]; comments: InlineComment[] };
  replyDrafts: { commentId: number; text: string }[];
}

export interface StackView {
  id: string;
  folder: string;
  branch: string;
  worktree: string;
  base?: string;
  order: PatchId[];
  summary?: string;
}

export interface PushView {
  id: PushId;
  purpose: string;
  command: string[];
  taskCount?: number;
  declined?: string; // why you said no, or why the factory withdrew it
  withdrawn?: boolean; // by the factory, not you
  rev?: string;
  url?: string;
  progress?: { done: number; total: number; failures: number };
  result?: "green" | "failures";
  summary?: string;
}

export interface NeedsUser {
  key: string;
  action: string;
  detail: string;
  item?: ItemId;
  patch?: PatchId;
  push?: PushId;
  stack?: string;
  job?: JobId;
  since: Iso;
}

export interface RefusedCommand {
  key: string; // "refused:<command id>", what dismiss names
  command: string; // its id
  cmd?: Command["cmd"]; // absent when the orchestrator failed before knowing it
  item?: ItemId; // what it was about: a later success of the same cmd about the same item and job clears it
  job?: JobId;
  detail?: string;
  t: Iso;
}

export interface RequestState {
  id: RequestId;
  kind: RequestKind;
  text: string;
  folder?: string;
  rev?: string;
  fromCommand?: string; // the tell-factory command that created it
  forwardedTo?: RequestId; // route-request said its text is about that request
  supersededBy?: RequestId; // route-request failed, and you rephrased it in the main box as that request
  createdAt: Iso;
  updatedAt: Iso;
  step: RequestStep;
  config: Record<string, unknown>;
  items: Record<ItemId, ItemView>;
  patches: Record<PatchId, PatchView>;
  stacks: Record<string, StackView>;
  pushes: Record<PushId, PushView>; // in creation order
  jobs: Record<JobId, JobView>;
  needsUser: NeedsUser[]; // open ones only
  metaBug?: { bug: number | null; draft?: BugDraft };
  recoveryPlans: { job: JobId; text: string; plan: PlannedCommand[]; cannotDo: string[]; questions: string[]; t: Iso }[];
  // The latest commands the orchestrator refused, until dismissed or a later command with the same cmd succeeds.
  // Optional: folded states saved before it existed don't have it.
  refused?: RefusedCommand[];
  notes: { t: Iso; text: string }[];
}

export interface AddressReviewReport {
  state: "addressed" | "blocked";
  summary: string;
  commits: string[]; // the amended commit(s), oldest first
  replies: { commentId: number; text: string }[]; // only where the code doesn't speak for itself
  feedback: Feedback[];
}

// ---------------------------------------------------------------------------
// Jobs the orchestrator starts

// Why the orchestrator started a job, in its job-started event: after a restart, this is how it
// knows what each job was for. Fields other than key and what depend on the job.
export interface JobPurpose {
  key: string; // one job (plus its retry) per key: next() never starts a key that has a job
  what: string;
  item?: ItemId;
  patch?: PatchId;
  push?: PushId;
  stack?: string;
  index?: number;
  sha?: string;
  args?: string[]; // mach try arguments of a dry-run, reused by the push
  cwd?: string; // the worktree a dry-run ran in, reused by the push
  purpose?: string; // a planned push's one-line purpose
  edits?: Record<PatchId, number>; // bug numbers a rewrite puts in commit messages
  patches?: Record<string, PatchId>; // 12-character sha prefix → patch, for the shas a stack.ts job gets
  comments?: number[]; // review comment ids an address-review run handles
  reason?: string; // why an author is resumed: "lint", "review", "try", "comment", ...; what you told recover
  replyTo?: JobId; // the recover run a reply-recovery answers
  requests?: RequestId[]; // the active requests a route-request run was given: its answer must be one of them
}

// ---------------------------------------------------------------------------
// Reports of the other prompts

// Either existing (the text is about that request), or kind and the rest (a new request). The schema
// can't say "either", so the handler checks it.
export interface RouteRequestReport {
  existing?: RequestId;
  kind?: Exclude<RequestKind, "unrouted">;
  folder?: string;
  rev?: string;
  config?: { folders: string[]; tests: string[]; platforms: string[]; constraints: string[] };
  questions?: string[];
  feedback: Feedback[];
}

export interface ClassifyAnnotationReport {
  kind: "scoping" | "flakiness" | "unclear";
  reason: string;
  feedback: Feedback[];
}

export interface WriteAnnotationPatchesReport {
  runIf?: string; // sha of the run-if commit, absent when no skip was scoping
  debug?: string; // sha of the DEBUG un-skip commit, absent when no skip was flakiness
  summary: string;
  feedback: Feedback[];
}

export interface PlanTryPushesReport {
  pushes: { purpose: string; tryArgs: string[]; rebuild: number }[];
  feedback: Feedback[];
}

export type TriageVerdict = "fixed" | "still failing" | "broken by patch" | "pre-existing" | "infra";

export interface TriageTryReport {
  cells: { test?: string; config?: string; taskId?: string; verdict: TriageVerdict; patch?: string; evidence: string }[];
  feedback: Feedback[];
}

export interface MergeClustersReport {
  groups: { message: string; tests: string[]; configs: string[]; from: string[]; reason: string }[];
  feedback: Feedback[];
}

export interface PriorArtVerdictReport {
  verdict: "active" | "reuse" | "none";
  bug?: number;
  quote: string;
  feedback: Feedback[];
}

export interface ReviseBugDraftReport {
  draft: BugDraft;
  feedback: Feedback[];
}

export interface ResolveConflictReport {
  state: "resolved" | "semantic";
  commit?: string; // the resolved commit's sha, when resolved
  explanation: string;
  feedback: Feedback[];
}

export interface EstimateReviewEffortReport {
  effort: number;
  reason: string;
  feedback: Feedback[];
}

export interface ReviewStackReport {
  findings: { patch: string; severity: "must-fix" | "nit"; text: string }[]; // patch: a commit sha of the stack
  addDeps: { patch: string; needs: string; kind: Dep["kind"]; reason: string }[];
  removeDeps: { patch: string; needs: string; reason: string }[];
  feedback: Feedback[];
}

export interface ClassifyReviewCommentsReport {
  comments: { id: number; kind: NonNullable<InlineComment["kind"]>; impliesChange: boolean }[];
  feedback: Feedback[];
}

export interface AdaptSoftDepReport {
  state: "adapted" | "not trivial";
  commits: string[];
  summary: string;
  feedback: Feedback[];
}
