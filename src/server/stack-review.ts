import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../lib/exec.ts";
import { gitDirFor } from "../lib/kept.ts";
import type { PatchId, PatchView, RequestState, StackView } from "../types.ts";
import { buildAnnotations, type Annotations, type AnnotationIo } from "./review-annotations.ts";

// A git revision name that can't be taken for an option: a sha, a branch, HEAD~2, sha^.
export function isRevName(rev: string): boolean {
  return /^[A-Za-z0-9_][\w./^~@{}-]*$/.test(rev) && !rev.includes("..") && rev.length <= 200;
}

// Whether this stack-viewer takes --annotations (md-viewer's main since it does): its --help says. Asked again every
// 10 minutes, as tools.ts update may have brought a newer one.
const helps = new Map<string, { at: number; annotations: boolean }>();
export async function takesAnnotations(command: string[], now = Date.now()): Promise<boolean> {
  const key = command.join("\0");
  const known = helps.get(key);
  if (known && now - known.at < 10 * 60_000) return known.annotations;
  const r = await exec([...command, "--help"]).catch(() => ({ code: 1, stdout: "" }));
  const annotations = r.code === 0 && r.stdout.includes("--annotations");
  helps.set(key, { at: now, annotations });
  return annotations;
}

// Runs stack-viewer on a range into a page; with annotations, passes them (and the page's script then sends what you do
// with them).
async function runViewer(command: string[], gitDir: string, range: string, annotations: Annotations | undefined): Promise<string> {
  // A directory per page, so two reviews of the same stack don't share a file.
  const dir = mkdtempSync(join(tmpdir(), "fix-factory-stack-viewer-"));
  try {
    const file = join(dir, "review.html");
    const extra: string[] = [];
    if (annotations) {
      const path = join(dir, "annotations.json");
      writeFileSync(path, JSON.stringify(annotations));
      extra.push("--annotations", path);
    }
    // --no-open: with -o, stack-viewer would otherwise open a browser on the server.
    const cmd = [...command, "--no-open", "-R", gitDir, "-o", file, ...extra, range];
    const r = await exec(cmd);
    if (r.code !== 0) {
      throw new Error(`${cmd.join(" ")} exited with ${r.code}: ${r.stderr.trim().slice(-2000)}`);
    }
    return readFileSync(file, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}


// stack-viewer's output for the stack, with the button that sends its comments to
// the factory. The base is `base`, else the stack's, else the parent of its first patch.
export async function buildStackReview(opts: { repo: string; command: string[]; request: RequestState; stack: StackView; base?: string; annotations?: AnnotationIo }): Promise<string> {
  const { request, stack } = opts;
  const first = request.patches[stack.order[0]];
  const base = opts.base ?? stack.base ?? (first ? `${first.sha}^` : undefined);
  if (!base) {
    throw new Error(`stack ${stack.id} has no patches`);
  }
  for (const rev of [base, stack.branch]) {
    if (!isRevName(rev)) {
      throw new Error(`not a revision name: ${rev}`);
    }
  }
  // The page shows the branch as git has it, which can be ahead of the factory (moz-phab submit gave its commits
  // their revisions, not read yet): a commit the factory doesn't know by its sha is its patch of the same title.
  const shas: Record<string, PatchId> = Object.fromEntries(stack.order.map((id) => [request.patches[id].sha, id]));
  const log = await exec(["git", "-C", stack.worktree, "log", "--format=%H%x09%s", `${base}..${stack.branch}`]);
  const shown = log.code === 0 ? log.stdout.split("\n").filter(Boolean).map((line) => line.split("\t")) : [];
  for (const [sha, title] of shown) {
    const same = stack.order.filter((id) => request.patches[id].title === title);
    if (!shas[sha] && same.length === 1) shas[sha] = same[0];
  }
  // Annotated: the commits the page shows (those the log read), else the factory's.
  const onPage = shown.length ? Object.fromEntries(shown.filter(([sha]) => shas[sha]).map(([sha]) => [sha, shas[sha]])) : shas;
  const annotations = opts.annotations && buildAnnotations(request, onPage, opts.annotations);
  const page = await runViewer(opts.command, gitDirFor({ firefoxRepo: opts.repo }, stack.worktree), `${base}..${stack.branch}`, annotations);
  return injectSendButton(page, { request: request.id, stack: stack.id, shas, ...(annotations ? { annotations } : {}) });
}

// One patch (a commit in its author's worktree) in stack-viewer; comments go back to its author.
export async function buildPatchView(opts: { repo: string; command: string[]; request: RequestState; patch: PatchView; annotations?: AnnotationIo }): Promise<string> {
  const { request, patch } = opts;
  if (!isRevName(patch.sha)) {
    throw new Error(`not a revision name: ${patch.sha}`);
  }
  const shas = { [patch.sha]: patch.id };
  const annotations = opts.annotations && buildAnnotations(request, shas, opts.annotations);
  const page = await runViewer(opts.command, gitDirFor({ firefoxRepo: opts.repo }, patch.worktree), `${patch.sha}^..${patch.sha}`, annotations);
  return injectSendButton(page, { request: request.id, patch: patch.id, shas, ...(annotations ? { annotations } : {}) });
}

// What a try push would carry (the dry run's commits, newest first, in the worktree it pushes from), read-only.
export async function buildPushView(opts: { repo: string; command: string[]; cwd: string; commits: string[] }): Promise<string> {
  const newest = opts.commits[0];
  const oldest = opts.commits.at(-1)!;
  for (const rev of [newest, oldest]) {
    if (!isRevName(rev)) {
      throw new Error(`not a revision name: ${rev}`);
    }
  }
  return runViewer(opts.command, gitDirFor({ firefoxRepo: opts.repo }, opts.cwd), `${oldest}^..${newest}`, undefined);
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
      body: JSON.stringify(cfg.patch
        ? { cmd: "comment-fix", request: cfg.request, patch: cfg.patch, text: c.comments.map(function (x) { return x.text; }).join("\\n\\n") }
        : { cmd: "stack-comments", request: cfg.request, stack: cfg.stack, comments: c.comments })
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

// With annotations (stack-viewer's contract with the factory, in md-viewer's README): its actions (approve, the bug
// number) become commands right away, and the button sends what's new since the last send: new comments, those on the
// commit message and on the test plan included, and what you did to earlier ones. Each commit's frame then marks
// those sent, so the button stays usable.
const REVIEW_SCRIPT = `
(function () {
  var cfg = JSON.parse(document.getElementById("ff-review-config").textContent);
  var button = document.getElementById("ff-send");
  var label = button.textContent;
  function fullSha(sha) {
    for (var full in cfg.shas) {
      if (full.indexOf(sha) === 0 || sha.indexOf(full) === 0) return full;
    }
    return null;
  }
  function flash(text) {
    button.textContent = text;
    setTimeout(function () { button.textContent = label; }, 2500);
  }
  function post(command) {
    command.request = cfg.request;
    return fetch("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(command)
    }).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body.error || r.statusText);
        return body;
      });
    });
  }
  // The commit's annotation changed in place: its badge, actions and comments.
  function update(sha, change) {
    var a = cfg.annotations.commits[sha];
    change(a);
    if (typeof window.mdvSetAnnotations === "function") window.mdvSetAnnotations(sha, a);
  }
  window.addEventListener("mdv-action", function (e) {
    var d = e.detail;
    var sha = fullSha(d.commit);
    var patch = sha && cfg.shas[sha];
    if (!patch) return flash("Unknown commit");
    if (d.id === "approve") {
      post({ cmd: "approve", patch: patch, sha: sha }).then(function () {
        update(sha, function (a) {
          a.status = { kind: "approved", label: "Approved" };
          a.actions = a.actions.filter(function (x) { return x.id !== "approve"; });
        });
        flash("Approved");
      }).catch(function (err) { flash("Failed: " + err.message); });
    } else if (d.id === "set-bug") {
      var m = /(\\d{4,8})\\s*$/.exec(String(d.value || "").trim());
      if (!m) return flash("Not a bug number");
      post({ cmd: "set-bug", patch: patch, bug: Number(m[1]) }).then(function () {
        update(sha, function (a) {
          a.actions = a.actions.filter(function (x) { return x.id !== "set-bug"; });
          a.titleLinks = [];
        });
        flash("Bug " + m[1] + " set: the factory puts it in the commit message");
      }).catch(function (err) { flash("Failed: " + err.message); });
    }
  });
  // An anchor stack-viewer gave, or one from where an older page says a comment is.
  function anchorOf(c) {
    if (c.anchor) return c.anchor;
    var place = c.place || {};
    var a = { file: place.message ? "(commit)" : place.path || "(commit)" };
    if (typeof c.line === "number" && c.line > 0) a.line = c.line;
    if (place.side === "old" || place.side === "new") a.side = place.side;
    return a;
  }
  function collect() {
    var out = { comments: [], responses: [], marks: [], unknown: 0 };
    var wins = [window];
    var frames = document.querySelectorAll("iframe");
    for (var i = 0; i < frames.length; i++) if (frames[i].contentWindow) wins.push(frames[i].contentWindow);
    for (var j = 0; j < wins.length; j++) {
      var win = wins[j];
      if (typeof win.mdvReviewComments !== "function") continue;
      var el = win.document.querySelector("[data-commit]");
      var sha = el && fullSha(el.getAttribute("data-commit"));
      var patch = sha && cfg.shas[sha];
      var comments = win.mdvReviewComments();
      var responses = typeof win.mdvReviewResponses === "function" ? win.mdvReviewResponses() : [];
      if (!comments.length && !responses.length) continue;
      if (!patch) { out.unknown++; continue; }
      var ids = [];
      for (var k = 0; k < comments.length; k++) {
        var c = comments[k];
        var text = typeof win.mdvReviewEntries === "function" ? win.mdvReviewEntries([c]) : JSON.stringify(c, null, 2);
        var item = { patch: patch, text: text, anchor: anchorOf(c), sha: sha };
        if (c.id) { item.id = c.id; ids.push(c.id); }
        out.comments.push(item);
      }
      for (var n = 0; n < responses.length; n++) {
        var r = responses[n];
        var x = { patch: patch, id: r.id, response: r.response };
        if (typeof r.text === "string") x.text = r.text;
        out.responses.push(x);
        ids.push(r.id);
      }
      out.marks.push({ win: win, ids: ids });
    }
    return out;
  }
  button.addEventListener("click", function () {
    var c = collect();
    if (!c.comments.length && !c.responses.length) return flash(c.unknown ? "Comments on unknown commits" : "Nothing new to send");
    button.disabled = true;
    post({ cmd: "review-send", comments: c.comments, responses: c.responses }).then(function () {
      for (var i = 0; i < c.marks.length; i++) if (typeof c.marks[i].win.mdvReviewMarkSent === "function") c.marks[i].win.mdvReviewMarkSent(c.marks[i].ids);
      button.disabled = false;
      var parts = [];
      if (c.comments.length) parts.push(c.comments.length + (c.comments.length === 1 ? " comment" : " comments"));
      if (c.responses.length) parts.push(c.responses.length + (c.responses.length === 1 ? " answer" : " answers"));
      flash("Sent " + parts.join(" and "));
    }).catch(function (e) {
      button.disabled = false;
      button.textContent = "Failed: " + e.message;
    });
  });
})();
`;

export function injectSendButton(page: string, cfg: { request: string; stack?: string; patch?: string; shas: Record<string, string>; annotations?: Annotations }): string {
  const snippet =
    `<button id="ff-send" type="button" style="position:fixed;right:12px;bottom:12px;z-index:1000;padding:6px 12px;border-radius:6px;border:1px solid #2a78d6;background:#2a78d6;color:#fff;font:13px system-ui,sans-serif;cursor:pointer">Send comments to the factory</button>` +
    `<script type="application/json" id="ff-review-config">${jsonForScript(cfg)}</script>` +
    `<script>${cfg.annotations ? REVIEW_SCRIPT : SEND_SCRIPT}</script>`;
  const i = page.lastIndexOf("</body>");
  return i < 0 ? page + snippet : page.slice(0, i) + snippet + page.slice(i);
}
