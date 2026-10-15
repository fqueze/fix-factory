// The real StateSource and CommandSink: requests/<id>/events.jsonl folded and tailed,
// and commands.jsonl appended to.
import { existsSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { appendCommand, type CommandInput } from "../state/commands.ts";
import { listRequests, readEventsFrom, tailEvents } from "../state/events.ts";
import { foldEvents } from "../state/fold.ts";
import type { Event, RequestId, RequestState } from "../types.ts";
import type { CommandSink, StateSource } from "./state-source.ts";

interface Tracked {
  events: Event[];
  // Undefined until the first complete event: foldEvents needs one.
  state?: RequestState;
  stop: () => void;
}

// Each change re-folds the request from scratch: folding 10,000 events takes a few
// milliseconds (see state-dir.test.ts), and fold.ts stays the only place that knows
// how events combine.
export class StateDirSource implements StateSource {
  readonly stateDir: string;
  private readonly pollMs: number;
  private readonly requests = new Map<RequestId, Tracked>();
  private readonly listeners = new Set<(id: RequestId) => void>();
  private timer?: NodeJS.Timeout;
  private watcher?: FSWatcher;

  constructor(stateDir: string, opts: { pollMs?: number } = {}) {
    this.stateDir = stateDir;
    this.pollMs = opts.pollMs ?? 1000;
  }

  // Reads every request synchronously, so the first page is complete, then follows changes.
  start(): void {
    this.scan();
    // fs.watch for quick pickup of new requests; polling for when requests/ doesn't
    // exist yet, or the filesystem doesn't report changes.
    this.timer = setInterval(() => {
      this.ensureWatcher();
      this.scan();
    }, this.pollMs);
    this.ensureWatcher();
  }

  close(): void {
    clearInterval(this.timer);
    this.watcher?.close();
    this.watcher = undefined;
    for (const r of this.requests.values()) {
      r.stop();
    }
    this.requests.clear();
  }

  listRequests(): RequestState[] {
    const out: RequestState[] = [];
    for (const r of this.requests.values()) {
      if (r.state) out.push(r.state);
    }
    return out;
  }

  getRequest(id: RequestId): RequestState | undefined {
    return this.requests.get(id)?.state;
  }

  getEvents(id: RequestId): Event[] {
    return this.requests.get(id)?.events ?? [];
  }

  subscribe(onChange: (id: RequestId) => void): () => void {
    this.listeners.add(onChange);
    return () => {
      this.listeners.delete(onChange);
    };
  }

  private ensureWatcher(): void {
    const dir = join(this.stateDir, "requests");
    if (this.watcher || !existsSync(dir)) return;
    this.watcher = watch(dir, () => this.scan());
    this.watcher.on("error", () => {
      this.watcher?.close();
      this.watcher = undefined;
    });
  }

  private scan(): void {
    for (const id of listRequests(this.stateDir)) {
      if (!this.requests.has(id)) this.track(id);
    }
  }

  private track(id: RequestId): void {
    const { events, offset } = readEventsFrom(this.stateDir, id, 0);
    const tracked: Tracked = { events, stop: () => {} };
    this.requests.set(id, tracked);
    this.refold(id, tracked);
    tracked.stop = tailEvents(
      this.stateDir,
      id,
      offset,
      (more) => {
        tracked.events.push(...more);
        this.refold(id, tracked);
      },
      { pollMs: this.pollMs },
    );
  }

  private refold(id: RequestId, tracked: Tracked): void {
    if (tracked.events.length === 0) return;
    tracked.state = foldEvents(tracked.events);
    for (const l of this.listeners) {
      l(id);
    }
  }
}

export class StateDirCommandSink implements CommandSink {
  readonly stateDir: string;
  constructor(stateDir: string) {
    this.stateDir = stateDir;
  }
  append(command: CommandInput): void {
    appendCommand(this.stateDir, command);
  }
}
