import { existsSync, readdirSync, readFileSync, watch } from "node:fs";
import { join } from "node:path";
import type { CommandInput } from "../state/commands.ts";
import type { Event, RequestId, RequestState } from "../types.ts";

// What the web server reads. The integrator wires this to src/state/.
export interface StateSource {
  listRequests(): RequestState[];
  getRequest(id: RequestId): RequestState | undefined;
  // The request's raw events, for the request profile (try push and needs-user
  // intervals aren't kept in the folded state). Without it the profile only has jobs.
  getEvents?(id: RequestId): Event[];
  // Called with the id of the request that changed. Returns the unsubscribe function.
  subscribe(onChange: (id: RequestId) => void): () => void;
}

// Where the web server writes. The integrator wires this to commands.jsonl,
// which adds id, v and t.
export interface CommandSink {
  append(command: CommandInput): void;
}

export class MemoryStateSource implements StateSource {
  private requests = new Map<RequestId, RequestState>();
  private events = new Map<RequestId, Event[]>();
  private listeners = new Set<(id: RequestId) => void>();

  constructor(requests: RequestState[] = [], events: Record<RequestId, Event[]> = {}) {
    for (const r of requests) {
      this.requests.set(r.id, r);
    }
    for (const [id, list] of Object.entries(events)) {
      this.events.set(id, list);
    }
  }

  listRequests(): RequestState[] {
    return [...this.requests.values()];
  }

  getRequest(id: RequestId): RequestState | undefined {
    return this.requests.get(id);
  }

  getEvents(id: RequestId): Event[] {
    return this.events.get(id) ?? [];
  }

  set(request: RequestState, events?: Event[]): void {
    this.requests.set(request.id, request);
    if (events) {
      this.events.set(request.id, events);
    }
    for (const l of this.listeners) {
      l(request.id);
    }
  }

  subscribe(onChange: (id: RequestId) => void): () => void {
    this.listeners.add(onChange);
    return () => {
      this.listeners.delete(onChange);
    };
  }
}

export class MemoryCommandSink implements CommandSink {
  readonly commands: CommandInput[] = [];
  append(command: CommandInput): void {
    this.commands.push(command);
  }
}

// A directory of folded states, <id>.json, each optionally with <id>.events.jsonl
// for its profile. Edited files are picked up live, to try the page without the
// orchestrator.
export class FixtureStateSource extends MemoryStateSource {
  readonly dir: string;

  constructor(dir: string) {
    super();
    this.dir = dir;
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".json")) {
        this.load(name.slice(0, -".json".length));
      }
    }
  }

  private load(name: string): void {
    const path = join(this.dir, `${name}.json`);
    if (!existsSync(path)) {
      return;
    }
    // Fixtures written before these fields: what a fold of their events gives.
    const state = { patchSent: {}, patchShas: {}, reopened: {}, backouts: {}, ...JSON.parse(readFileSync(path, "utf8")) } as RequestState;
    const eventsPath = join(this.dir, `${name}.events.jsonl`);
    const events = existsSync(eventsPath)
      ? readFileSync(eventsPath, "utf8")
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l) as Event)
      : [];
    this.set(state, events);
  }

  watch(): () => void {
    const watcher = watch(this.dir, (_type, name) => {
      const m = name?.match(/^(.*?)(\.events\.jsonl|\.json)$/);
      if (m) {
        try {
          this.load(m[1]);
        } catch (e) {
          // Half-written files while editing a fixture.
          process.stderr.write(`fixture ${name}: ${e instanceof Error ? e.message : String(e)}\n`);
        }
      }
    });
    return () => watcher.close();
  }
}
