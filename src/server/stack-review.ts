import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { exec } from "../lib/exec.ts";
import type { RequestState, StackView } from "../types.ts";

export function findStack(requests: RequestState[], stackId: string): { request: RequestState; stack: StackView } | undefined {
  for (const request of requests) {
    const stack = request.stacks[stackId];
    if (stack) {
      return { request, stack };
    }
  }
  return undefined;
}

// stack-viewer's output for the stack, with the button that sends its comments to
// the factory. `base` defaults to the parent of the stack's first patch.
export async function buildStackReview(opts: {
  command: string[];
  outDir: string;
  request: RequestState;
  stack: StackView;
  base?: string;
}): Promise<string> {
  const { request, stack } = opts;
  const first = request.patches[stack.order[0]];
  const base = opts.base ?? (first ? `${first.sha}^` : undefined);
  if (!base) {
    throw new Error(`stack ${stack.id} has no patches`);
  }
  mkdirSync(opts.outDir, { recursive: true });
  const file = join(opts.outDir, `${stack.id.replace(/[^\w.-]/g, "_")}.html`);
  // --no-open: with -o, stack-viewer would otherwise open a browser on the server.
  const cmd = [...opts.command, "--no-open", "-R", stack.worktree, "-o", file, `${base}..${stack.branch}`];
  const r = await exec(cmd);
  if (r.code !== 0) {
    throw new Error(`${cmd.join(" ")} exited with ${r.code}: ${r.stderr.trim().slice(-2000)}`);
  }
  const shas = Object.fromEntries(stack.order.map((id) => [request.patches[id]?.sha, id]).filter(([sha]) => sha));
  return injectSendButton(readFileSync(file, "utf8"), { request: request.id, stack: stack.id, shas });
}

// JSON safe inside a <script> element.
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

// The commit pages are iframes created when first opened; each holds its comments
// and identifies its commit with data-commit. Same origin, so they can be read.
const SEND_SCRIPT = `
(function () {
  var cfg = JSON.parse(document.getElementById("ff-review-config").textContent);
  var button = document.getElementById("ff-send");
  function patchFor(sha) {
    for (var full in cfg.shas) {
      if (full.indexOf(sha) === 0 || sha.indexOf(full) === 0) return cfg.shas[full];
    }
    return null;
  }
  function collect() {
    var out = [];
    var unknown = 0;
    var frames = document.querySelectorAll("iframe");
    for (var i = 0; i < frames.length; i++) {
      var win = frames[i].contentWindow;
      var doc = frames[i].contentDocument;
      if (!win || !doc || typeof win.mdvReviewComments !== "function") continue;
      var comments = win.mdvReviewComments();
      if (!comments.length) continue;
      var el = doc.querySelector("[data-commit]");
      var patch = el && patchFor(el.getAttribute("data-commit"));
      if (!patch) { unknown++; continue; }
      var text = typeof win.mdvReviewEntries === "function" ? win.mdvReviewEntries(comments) : JSON.stringify(comments, null, 2);
      out.push({ patch: patch, text: text });
    }
    return { comments: out, unknown: unknown };
  }
  button.addEventListener("click", function () {
    var c = collect();
    if (!c.comments.length) {
      button.textContent = c.unknown ? "Comments on unknown commits" : "No comments yet";
      setTimeout(function () { button.textContent = "Send comments to the factory"; }, 1500);
      return;
    }
    button.disabled = true;
    fetch("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ cmd: "stack-comments", request: cfg.request, stack: cfg.stack, comments: c.comments })
    }).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body.error || r.statusText);
        button.textContent = "Sent " + c.comments.length + (c.comments.length === 1 ? " commit's comments" : " commits' comments");
      });
    }).catch(function (e) {
      button.disabled = false;
      button.textContent = "Failed: " + e.message;
    });
  });
})();
`;

export function injectSendButton(page: string, cfg: { request: string; stack: string; shas: Record<string, string> }): string {
  const snippet =
    `<button id="ff-send" type="button" style="position:fixed;right:12px;bottom:12px;z-index:1000;padding:6px 12px;border-radius:6px;border:1px solid #2a78d6;background:#2a78d6;color:#fff;font:13px system-ui,sans-serif;cursor:pointer">Send comments to the factory</button>` +
    `<script type="application/json" id="ff-review-config">${jsonForScript(cfg)}</script>` +
    `<script>${SEND_SCRIPT}</script>`;
  const i = page.lastIndexOf("</body>");
  return i < 0 ? page + snippet : page.slice(0, i) + snippet + page.slice(i);
}
