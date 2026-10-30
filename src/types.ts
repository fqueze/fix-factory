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
  stateDir: string; // commands.jsonl, requests/, jobs/, feedback/, cache/, kept/
  firefoxRepo: string; // main checkout; worktrees are created next to it, never inside
  worktreesDir: string;
  baseRef: string; // central-based ref worktrees and stacks start from, e.g. "origin/main"
  phabPollMinutes?: number; // default 10, while you are present
  phabPollHours?: number; // default 3, while you are away
  claudeCommand: string[]; // e.g. ["mozsb", "claude"]; the runner appends -p and its flags
  // The viewers the page runs; by default the factory's own (tools.ts update).
  stackViewerCommand?: string[];
  mdViewerCommand?: string[]; // for the authors' evidence and reproduction files
  diffViewerCommand?: string[]; // for their widening patches
  profilerOrigin?: string; // a profiler front end for the profile links; by default the factory's own, on profilerPort
  profilerPort?: number; // where the page server serves it, by default port + 1
  bugzillaEmail?: string; // the bugs to file are assigned to it, ASSIGNED: you attach their patches
  maxWorktrees?: number; // group worktrees a request keeps at a time (default 4): each is ~6 GB
  metaBugBlocks?: number[]; // what a burndown's meta bug blocks, e.g. the flakiness tracker
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
  | "waiting for a try repro" // its DEBUG commit goes to try with the folder's others
  // terminal
  | "fixed"
  | "left as-is"
  | "handed back"
  | "taken over" // by you, in a session of your own: the factory leaves it, and its worktree, alone
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
  late?: string[]; // messages of groups merged in after its author started: it's told about them
}

export interface BugDraft {
  product: string;
  component: string;
  summary: string;
  description: string;
  blocks?: number[];
  dependsOn?: number[]; // a meta bug's: the bugs it tracks
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
  | (EventBase & { type: "request-split"; into: RequestId[]; moved?: Record<ItemId, RequestId> }) // archived: its groups went to these requests (moved: absent on the first split)
  | (EventBase & { type: "split-from"; from: RequestId }) // made by splitting that request
  | (EventBase & { type: "groups-moved"; to: RequestId; items: ItemId[] }) // they go on in that request
  | (EventBase & { type: "meta-draft-asked" }) // you want a meta bug for a stack that doesn't need one
  | (EventBase & { type: "tests-asked"; tests: string[] }) // failures already on central you want fixed too
  | (EventBase & { type: "author-queued"; item: ItemId; key: string; reason: string; message: string }) // your message to an author whose worktree is restored first
  | (EventBase & { type: "verify-asked"; text: string })
  | (EventBase & { type: "backout"; patch: PatchId; at: Iso; reason: string; culprit: boolean }) // its landing was backed out; culprit: the failure is its own (or nobody's could be told apart)
  | (EventBase & { type: "try-needed"; patch: PatchId; why: string; ask: string; job: JobId; after?: Iso }) // after: when its author answered // its fix answers failures try found: it lands once a push of it is green
  | (EventBase & { type: "try-verified"; patch: PatchId }) // that push is green: it may land
  | (EventBase & { type: "backout-verified"; patch: PatchId }) // a try push showed its fix green: it may land again // you want the stack pushed to try as it stands, whatever the step
  | (EventBase & { type: "comment-sent"; patch: PatchId; text: string; key: string }) // your comment on a patch, and the key of the author run answering it
  | (EventBase & { type: "config-set"; config: Record<string, unknown> })
  | (EventBase & { type: "step"; step: RequestStep })
  | (EventBase & { type: "item-created"; item: ItemId; folder: string; group: FailureGroup })
  | (EventBase & { type: "item-state"; item: ItemId; state: ItemState; detail?: string; coveredBy?: PatchId }) // coveredBy: the patch that fixes it too
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
      bugFromYou?: boolean; // the bug number you gave: kept when its author's commit still says Bug XXXXXXX
      bugDraft?: BugDraft;
      revision?: number; // D-number once submitted
      effort?: number; // 1-5
      testOnly?: boolean;
      interdiffFile?: string; // diff against the previously submitted version, relative to stateDir
    })
  | (EventBase & { type: "test-plan"; patch: PatchId; text: string })
  // What changed in a stack since its last push: each patch's commit then and now, the interdiff of those that changed.
  | (EventBase & { type: "push-changes"; stack: string; since: PushId; changes: PushChange[]; removed: { sha: string; title: string }[] })
  // What a planned push is for, against the stack's previous push: its regressions, and the patch that claims each fix.
  | (EventBase & { type: "try-context"; push: PushId; since?: PushId; regressions?: Regression[]; scope?: PushScope; revises?: PushId[] })
  | (EventBase & { type: "test-plan-sent"; patch: PatchId; revision: number; text: string })
  | (EventBase & { type: "reviewer-set"; patch: PatchId; reviewer: string }) // the r= you gave, when Phabricator knew none of mach's suggestions
  | (EventBase & { type: "hand-off"; job: JobId; items: ItemId[]; text: string }) // the prompt for your session taking them over
  | (EventBase & { type: "dep"; dep: Dep })
  | (EventBase & { type: "dep-removed"; patch: PatchId; needs: PatchId | string })
  | (EventBase & { type: "stack-dropped"; stack: string }) // made by an earlier rule (one per test folder), never submitted
  | (EventBase & { type: "stack"; stack: string; folder: string; branch: string; worktree: string; base?: string; order: PatchId[]; summary?: string })
  | (EventBase & { type: "meta-bug"; bug: number | null; draft?: BugDraft })
  | (EventBase & { type: "try-planned"; push: PushId; purpose: string; title?: string; command: string[]; taskCount?: number })
  | (EventBase & { type: "try-declined"; push: PushId; text: string; by?: "factory"; replan?: true }) // you said no, or the factory withdrew it
  | (EventBase & { type: "submit-copied"; stack: string })
  | (EventBase & { type: "try-pushed"; push: PushId; rev: string; url: string })
  | (EventBase & { type: "poll-requested" })
  | (EventBase & { type: "item-group"; item: ItemId; group: FailureGroup }) // its group, corrected
  | (EventBase & { type: "try-progress"; push: PushId; done: number; total: number; failures: number; tests?: { done: number; total: number } })
  | (EventBase & { type: "try-job-failed"; push: PushId; taskId: string; retryId?: number; jobName: string; platform: string; tier?: number; result: string })
  | (EventBase & { type: "try-finished"; push: PushId; result: "green" | "failures"; summary: string })
  | (EventBase & { type: "review-status"; patch: PatchId; revision: number; status: string; reviewers: ReviewerStatus[]; comments: InlineComment[]; diff?: PhabDiff; author?: string; reopenedAt?: Iso })
  | (EventBase & { type: "reply-draft"; patch: PatchId; commentId: number; text: string })
  | (EventBase & { type: "needs-user"; key: string; action: string; detail: string; item?: ItemId; patch?: PatchId; push?: PushId; stack?: string; job?: JobId })
  | (EventBase & { type: "user-done"; key: string; byFactory?: true; reorg?: true }) // clears a needs-user with the same key; byFactory: the factory found it moot, not your answer; reorg: you copied the moz-phab reorg command
  | (EventBase & { type: "command-executed"; command: string; ok: boolean; detail?: string; cmd?: Command["cmd"]; item?: ItemId; job?: JobId })
  | (EventBase & { type: "recovery-plan"; job: JobId; text: string; answer?: string; plan: PlannedCommand[]; cannotDo: string[]; questions: string[] })
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
  | (CommandBase & { cmd: "revise-push"; push: PushId; text: string }) // the agent that planned it plans what replaces it, from your text
  | (CommandBase & { cmd: "copied-submit"; stack: string }) // you copied its moz-phab command
  | (CommandBase & { cmd: "copied-reorg"; key: string }) // you copied the moz-phab reorg command of that land ⚑
  | (CommandBase & { cmd: "set-bug"; patch: PatchId; bug: number })
  | (CommandBase & { cmd: "comment-bug-draft"; patch: PatchId | "meta"; text: string })
  | (CommandBase & { cmd: "stack-comments"; stack: string; comments: { patch: PatchId; text: string }[] })
  | (CommandBase & { cmd: "take-it" | "hand-back"; item: ItemId })
  | (CommandBase & { cmd: "comment-fix"; patch: PatchId; text: string })
  | (CommandBase & { cmd: "set-test-plan"; patch: PatchId; text: string }) // on its revision
  | (CommandBase & { cmd: "revise-test-plan"; patch: PatchId; text: string }) // what its agent should change
  | (CommandBase & { cmd: "set-reviewer"; patch: PatchId; reviewer: string }) // its r=, e.g. "#ai-frontend-reviewers-rotation"
  | (CommandBase & { cmd: "draft-meta-bug" }) // its agent drafts the optional meta bug
  | (CommandBase & { cmd: "tell-factory"; text: string })
  | (CommandBase & { cmd: "reply-recovery"; job: JobId; text: string })
  | (CommandBase & { cmd: "start-now" })
  | (CommandBase & { cmd: "redo-annotations" }) // the skip-ifs group again, from today's manifests
  | (CommandBase & { cmd: "poll-phab" }) // check its revisions on Phabricator now
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
  | { cmd: "shell"; cwd: string; command: string; reason: string }
  | { cmd: "hand-off"; items: ItemId[]; reason: string }
  | { cmd: "split-request"; parts: { title: string; groups: { item: ItemId; why: string }[] }[]; reason: string }
  | { cmd: "move-groups"; to: RequestId; groups: { item: ItemId; why: string }[]; reason: string } // to another request of the same split, with their history
  | { cmd: "fix-tests"; tests: string[]; reason: string }
  | { cmd: "verify-stack"; reason: string }; // a try push of the stack as it stands, without going back a step // a group for each, from the try pushes' failures, even ones already on central // new requests taking these groups, with their history; this one archived // you take them over in a session of your own: the factory writes its prompt

// ---------------------------------------------------------------------------
// Agent reports: the structured_output of each prompt. The JSON schemas in
// schemas/<prompt>.json must match these.

export interface Feedback {
  target: "fx-tests" | "profiler-cli" | "searchfox-cli" | "factory" | "inputs";
  text: string;
}

export interface InvestigateReport {
  state: "fix verified locally" | "left as-is" | "handed back" | "blocked" | "not reproduced" | "needs a try repro"; // needs a try repro: commits are DEBUG commits widening the race
  summary: string; // one line, shown on the status page
  disagreement?: string; // why it didn't follow your message: the factory stops and asks you
  cause: string;
  evidence?: { source: "profile" | "log" | "local run" | "code reading"; ref?: string; finding: string }[]; // absent from reports older than it; ref: in the first ones
  verification: string;
  reproduction?: { reproduced: boolean; where?: "locally" | "on try"; widened?: boolean; command?: string; before: string; after?: string }; // command: in the first reports, before files
  files?: { evidence: string; reproduction: string; widening?: string }; // relative to the worktree
  profiles?: { profile: string; finding: string }[]; // the failing jobs' profiles read, and what each shows
  commits: string[]; // shas in the agent's worktree, oldest first
  bugDrafts?: { commits: string[]; draft: BugDraft }[]; // one per bug to file, with the commits it's for
  bugDraft?: BugDraft; // reports from before 2026-10-23: one draft, for its first commit without a bug
  tryRequest?: string; // a try push it needs: what to run and why; the factory plans it and asks you
  coveredBy?: string; // left as-is because a commit of the stack already fixes it: that commit
  replies?: { commentId: number; text: string }[]; // draft replies to reviewers that this run changed
  landsAfter: { what: string; reason: string }[];
  feedback: Feedback[];
}

export interface ReviewPatchReport {
  verdict: "ok" | "findings";
  findings: { severity: "must-fix" | "nit"; file?: string; line?: number; text: string }[];
  feedback: Feedback[];
}

export interface RecoverReport {
  answer: string; // to you, in a few sentences: what it will do and why, or what it needs from you
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
  outcome?: string; // an agent's report on one line: its status or verdict, and its summary
  said?: string; // an author's summary in full, or its disagreement: its answer to your comments
  machProfiles?: number; // resource-usage profiles of the mach builds and test runs it made, kept in its directory
}

export interface ItemView {
  id: ItemId;
  folder: string;
  group: FailureGroup;
  state: ItemState;
  detail?: string;
  coveredBy?: PatchId; // left as-is because that patch fixes it too
  jobs: JobId[]; // oldest first
  lastReport?: { prompt: string; report: unknown; job: JobId };
  commitCount?: number; // its latest fix's commits (patches p-<item>, p-<item>-2…)
  investigation?: InvestigateReport; // the latest investigate-and-fix report: cause, evidence, reproduction
}

export interface PatchView {
  id: PatchId;
  item?: ItemId;
  sha: string;
  worktree: string;
  title: string;
  bug: number | null;
  bugFromYou?: boolean; // the bug number you gave
  bugDraft?: BugDraft;
  revision?: number;
  submittedAt?: Iso; // when its revision first showed up
  sentSha?: string; // the commit Phabricator has, as far as the factory knows
  effort?: number;
  testOnly?: boolean;
  pastShas?: string[]; // its commit's earlier shas, oldest first
  interdiffFile?: string;
  deps: Dep[]; // deps where this patch is the dependent one
  review?: { revision: number; status: string; reviewers: ReviewerStatus[]; comments: InlineComment[]; diff?: PhabDiff; author?: string };
  replyDrafts: { commentId: number; text: string }[];
  testPlan?: string; // for its revision's Test Plan field: how the fix was shown to work, a few lines
  testPlanSent?: { revision: number; text: string; t: Iso }; // what you set on its revision
  reviewerFromYou?: string; // the r= you gave it
  yourComments?: { text: string; key: string; t: Iso }[]; // what you told its author (Comment on the fix, stack-viewer), oldest first
}

// The revision's latest diff: what Phabricator has, and the local commit moz-phab sent it from.
export interface PhabDiff {
  id: number;
  commit?: string;
  created: Iso;
}

export interface StackView {
  id: string;
  folder: string;
  branch: string;
  worktree: string;
  base?: string;
  order: PatchId[];
  summary?: string;
  submitCopied?: Iso; // when you last copied its moz-phab command: the factory looks for its revisions for a while
  submittedOrder?: PatchId[]; // its order when you last copied its moz-phab (or reorg) command: Phabricator's
}

export interface PushChange {
  patch: PatchId;
  status: "same" | "changed" | "new";
  old?: string;
  new: string;
  interdiffFile?: string; // relative to stateDir
}

export interface Regression {
  failure: string; // the failure on the previous push, with its tests
  status?: "fixed" | "not fixed" | "patch removed" | "pre-existing"; // absent in plans from before 2026-10-23
  causedBy?: PatchId; // the patch that broke it
  fixedBy?: PatchId; // the patch whose change since then claims to fix it; none: not fixed yet
  how: string; // what that change does about it, or why nothing does
}

export type PushScope = "stack" | "fixes" | "debug";

export interface PushView {
  id: PushId;
  scope?: PushScope; // what its planner said it covers
  revises?: PushId[]; // the pushes you asked to revise, that it replaces
  since?: PushId; // the stack's push it follows: its changes since then are in RequestState.pushChanges
  regressions?: Regression[];
  purpose: string;
  title?: string; // what it's for, in a few words
  command: string[];
  taskCount?: number;
  declined?: string; // why you said no, or why the factory withdrew it
  withdrawn?: boolean; // by the factory, not you
  replan?: boolean; // you asked the agent that planned it for a revision
  rev?: string;
  url?: string;
  progress?: { done: number; total: number; failures: number; tests?: { done: number; total: number } }; // tests: of those asked for
  result?: "green" | "failures";
  summary?: string;
  analysis?: TriageTryReport["cells"]; // what triage-try made of its failures that no patch's tests matched
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
  splitInto?: RequestId[]; // split into these, and archived
  movedTo?: Record<ItemId, RequestId>; // its groups the split moved, and where
  metaDraftAsked?: boolean; // you asked for a meta bug draft
  askedTests?: string[]; // failures already on central you asked to fix too, by test path
  queuedAuthors?: { item: ItemId; key: string; reason: string; message: string }[]; // your messages waiting for their author's worktree
  verifyAsked?: string[];
  reopened: Record<PatchId, Iso>; // when its revision went from closed (landed) back to open: a backout
  tryNeeded: Record<PatchId, { why: string; ask: string; job: JobId; at: Iso; after?: Iso; shas: string[]; verified?: boolean }>; // shas: the commits it has been since // fixes for what try found, until a push of them is green
  backouts: Record<PatchId, { at: Iso; reason: string; culprit: boolean; verified?: boolean }>; // patches whose landing was backed out // each time you asked for a try push of the stack as it stands, why
  splitFrom?: RequestId; // made by splitting that one
  createdAt: Iso;
  updatedAt: Iso;
  finishedAt?: Iso; // when its step became done
  step: RequestStep;
  config: Record<string, unknown>;
  items: Record<ItemId, ItemView>;
  patches: Record<PatchId, PatchView>;
  stacks: Record<string, StackView>;
  pushes: Record<PushId, PushView>; // in creation order
  patchSent: Record<PatchId, { sha: string; t: Iso }[]>; // each commit Phabricator had (its revision showing up, then its diffs), and since when
  patchShas: Record<PatchId, string[]>; // every commit each patch has been, oldest first: what tells whether a push had it
  pushChanges: Record<string, { since: PushId; changes: PushChange[]; removed: { sha: string; title: string }[] }>; // per stack, the latest
  jobs: Record<JobId, JobView>;
  needsUser: NeedsUser[]; // open ones only
  metaBug?: { bug: number | null; draft?: BugDraft };
  pollRequested?: Iso; // you asked to check Phabricator now
  recoveryPlans: { job: JobId; text: string; answer?: string; plan: PlannedCommand[]; cannotDo: string[]; questions: string[]; t: Iso }[];
  // The latest commands the orchestrator refused, until dismissed or a later command with the same cmd succeeds.
  // Optional: folded states saved before it existed don't have it.
  refused?: RefusedCommand[];
  notes: { t: Iso; text: string }[];
  handOffs: { job: JobId; items: ItemId[]; text: string; t: Iso }[]; // prompts for your sessions taking groups over
}

export interface AddressReviewReport {
  state: "addressed" | "blocked";
  summary: string;
  commits: string[]; // the amended commit(s), oldest first
  replies: { commentId: number; text: string }[]; // only where the code doesn't speak for itself
  tryRequest?: string; // as InvestigateReport's
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
  draft?: BugDraft; // a meta-bug draft without its description, which the job writes
  push?: PushId;
  pushes?: PushId[]; // the pushes a plan-pushes revision replaces
  stack?: string;
  index?: number;
  sha?: string;
  args?: string[]; // mach try arguments of a dry-run, reused by the push
  cwd?: string; // the worktree a dry-run ran in, reused by the push
  purpose?: string; // a planned push's one-line purpose
  title?: string; // and what it's for, in a few words
  edits?: Record<PatchId, number>; // bug numbers a rewrite puts in commit messages
  titles?: Record<PatchId, string>; // first lines a rewrite gives commit messages (reviewers)
  patches?: Record<string, PatchId>; // 12-character sha prefix → patch, for the shas a stack.ts job gets
  comments?: number[]; // review comment ids an address-review run handles
  reason?: string; // why an author is resumed: "lint", "review", "try", "comment", ...; what you told recover or said on a bug draft
  replyTo?: JobId; // the recover run a reply-recovery answers
  retried?: boolean; // an agent's retry: its session resumed where it stopped
  requests?: RequestId[]; // the active requests a route-request run was given: its answer must be one of them
}

// ---------------------------------------------------------------------------
// Reports of the other prompts

export interface WriteHandOffReport {
  prompt: string;
  feedback: Feedback[];
}

export interface WriteTestPlanReport {
  testPlan: string;
  feedback: Feedback[];
}

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
  removal?: string; // sha of the commit removing the skips that no longer fail, once try showed it
  tryRequest?: string; // as InvestigateReport's
  keepSkips?: { skip: string; failure: string }[]; // skips whose tests still fail: put back only once you agree
  summary: string;
  feedback: Feedback[];
}

export interface PlanTryPushesReport {
  pushes: { title?: string; purpose: string; tryArgs: string[]; rebuild: number; scope?: PushScope }[];
  regressions?: Regression[]; // when the stack had an earlier push: each of its regressions, and what fixes it
  answer?: string; // revising: what it changed and why, or why it couldn't
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

export interface WriteMetaBugReport {
  description: string;
  summary?: string; // when the request isn't a burndown
  answer?: string; // after your comment: what it changed, or why not
  product?: string; // fields you asked to change
  component?: string;
  blocks?: number[];
  feedback: Feedback[];
}

export interface ReviseBugDraftReport {
  draft: BugDraft;
  answer: string; // to you: what it changed, or what it needs from you
  feedback: Feedback[];
}

export interface ResolveConflictReport {
  state: "resolved" | "already fixed" | "semantic"; // already fixed: the base fixes what the patch does
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
