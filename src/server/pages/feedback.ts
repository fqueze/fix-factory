// What agents said about the factory and its tools (the feedback in their reports), newest first, per target.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Feedback, RequestState } from "../../types.ts";
import { html, type Html } from "../html.ts";
import { requestName, requestUrl } from "./common.ts";
import { md } from "./md.ts";

const TARGETS: Feedback["target"][] = ["factory", "inputs", "fx-tests", "profiler-cli", "searchfox-cli"];

export interface FeedbackEntry {
  at: string;
  job: string;
  text: string;
}

// appendFeedback's format: "## <ISO date> — job <id>", a blank line, the text.
export function parseFeedback(text: string): FeedbackEntry[] {
  return text
    .split(/^## /m)
    .slice(1)
    .map((chunk) => {
      const nl = chunk.indexOf("\n");
      const m = chunk.slice(0, nl).match(/^(\S+) — job (\S+)/);
      return { at: m?.[1] ?? "", job: m?.[2] ?? "", text: chunk.slice(nl + 1).trim() };
    });
}

export function readFeedback(stateDir: string): Record<Feedback["target"], FeedbackEntry[]> {
  const out = {} as Record<Feedback["target"], FeedbackEntry[]>;
  for (const t of TARGETS) {
    const file = join(stateDir, "feedback", `${t}.md`);
    out[t] = existsSync(file) ? parseFeedback(readFileSync(file, "utf8")).reverse() : [];
  }
  return out;
}

export function feedbackCount(stateDir: string): number {
  return Object.values(readFeedback(stateDir)).reduce((n, e) => n + e.length, 0);
}

export function renderFeedback(byTarget: Record<Feedback["target"], FeedbackEntry[]>, requests: RequestState[], target: Feedback["target"] = "factory"): string {
  const requestOf = new Map(requests.flatMap((r) => Object.keys(r.jobs).map((j) => [j, r] as const)));
  const entry = (e: FeedbackEntry): Html => {
    const r = requestOf.get(e.job);
    const job = r?.jobs[e.job];
    return html`<li class="fb"><div class="sub">${e.at.slice(0, 16).replace("T", " ")} · ${r ? html`<a href="${requestUrl(r.id)}">${requestName(r)}</a>` : "unknown request"}${job ? html` · ${job.name}${job.item ? ` (${job.item})` : ""}` : null} · <code>${e.job}</code></div>${md(e.text)}</li>`;
  };
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Feedback · Fix factory</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header><div class="hwrap">
  <h1><a href="/">🏭 Fix factory</a> · Agents' feedback</h1>
  <nav class="fbtabs">${TARGETS.map((t) => html`<a href="/feedback?target=${t}" class="${t === target ? "current" : ""}">${t} <b>${byTarget[t].length}</b></a>`)}</nav>
</div></header>
<main>
<ul class="fblist">${byTarget[target].map(entry)}</ul>
</main>
</body>
</html>
`.value;
}
