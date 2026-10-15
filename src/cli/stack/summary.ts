import type { PatchId } from "../../types.ts";

export interface SummaryPatch {
  id: PatchId;
  title: string;
  bug: number | null;
  revision?: number;
  effort?: number;
  value?: number; // failures/week
  repro?: string; // one line: how the failure reproduces
}

export interface SummaryInput {
  folder?: string;
  patches: SummaryPatch[]; // in stack order, unless `order` is given
  order?: PatchId[];
}

const BUG_URL = "https://bugzilla.mozilla.org/show_bug.cgi?id=";
const PHAB_URL = "https://phabricator.services.mozilla.com/D";

// "Bug 123 - Fix the thing, r=foo." → "Fix the thing"
function description(title: string): string {
  return title.replace(/^Bug (\d+|X+)\s*-\s*/i, "").replace(/,?\s*r[=?]\S+$/, "").replace(/\.$/, "");
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const fmtValue = (v: number | undefined) => (v === undefined ? "?" : String(Math.round(v * 10) / 10));

export function summary(input: SummaryInput): { markdown: string; metaComment: string } {
  let patches = input.patches;
  if (input.order) {
    const byId = new Map(patches.map((p) => [p.id, p]));
    patches = input.order.map((id) => {
      const p = byId.get(id);
      if (!p) throw new Error(`order lists ${id}, which isn't in patches`);
      return p;
    });
  }
  const bug = (p: SummaryPatch) => (p.bug === null ? "Bug to file" : `[Bug ${p.bug}](${BUG_URL}${p.bug})`);
  const rows = patches.map((p, i) => {
    const rev = p.revision ? ` ([D${p.revision}](${PHAB_URL}${p.revision}))` : "";
    return `| ${i + 1} | ${bug(p)} - ${cell(description(p.title))}${rev} | ${p.effort ?? "?"} | ${fmtValue(p.value)} | ${cell(p.repro ?? "")} |`;
  });
  const markdown = ["| # | Patch | Effort | Failures/week | Repro |", "|---|---|---|---|---|", ...rows].join("\n") + "\n";

  const total = patches.reduce((s, p) => s + (p.value ?? 0), 0);
  const where = input.folder ? ` in ${input.folder}` : "";
  const lines = patches.map((p) => {
    const b = p.bug === null ? "(bug to file)" : `Bug ${p.bug}`;
    const repro = p.repro ? ` Repro: ${p.repro}` : "";
    return `- ${b}: ${description(p.title)} (effort ${p.effort ?? "?"}/5, ${fmtValue(p.value)} failures/week).${repro}`;
  });
  const metaComment = [
    `This stack fixes intermittent failures${where}: ${patches.length} patches, about ${fmtValue(total)} failures/week in total.`,
    "",
    "In stack order, easiest to review first:",
    ...lines,
  ].join("\n") + "\n";
  return { markdown, metaComment };
}
