import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../lib/exec.ts";
import { gitDirFor } from "../lib/kept.ts";
import type { PatchId, PatchView, RequestState, StackView } from "../types.ts";
import { buildAnnotations, SEND_LABEL, type Annotations, type AnnotationIo } from "./review-annotations.ts";
import { sameBugDraft } from "../state/meta-bug.ts";
import { requestName, shortTitle } from "./pages/common.ts";
import type { ReviewPages } from "./review-pages.ts";

// md-viewer's API, when the factory serves the review pages itself (review-pages.ts): where the stack page fetches a
// commit's page (the patch it is, when known, gives its annotation), and where the pages' assets are.
export interface Served {
  pages: ReviewPages;
  pageUrl: (sha: string, patch: PatchId | undefined, annotated: boolean) => string;
  assetUrl: (name: string) => string;
}

// The page for a range: the stack page from the API, else stack-viewer's.
async function viewerPage(o: { command: string[]; served?: Served; gitDir: string; range: string; annotations?: Annotations; shas: Record<string, PatchId> }): Promise<string> {
  if (!o.served) return runViewer(o.command, o.gitDir, o.range, o.annotations);
  const served = o.served;
  const { html } = await served.pages.shell({
    dir: o.gitDir,
    range: o.range,
    title: o.range,
    annotations: o.annotations ?? null,
    pageUrl: (sha) => served.pageUrl(sha, o.shas[sha], o.annotations !== undefined),
    assetUrl: served.assetUrl,
  });
  return html;
}

// The first patch, oldest first, left for you to review: what the page opens on.
function firstToReview(annotations: Annotations, oldestFirst: string[]): string | undefined {
  return oldestFirst.find((sha) => {
    const status = annotations.commits[sha]?.status;
    return status !== undefined && status.kind !== "approved";
  });
}

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
export async function buildStackReview(opts: { repo: string; command: string[]; request: RequestState; stack: StackView; base?: string; annotations?: AnnotationIo; served?: Served }): Promise<string> {
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
  // The request's name, and the stack's folder when it has several.
  const title = Object.keys(request.stacks).length > 1 && stack.folder ? `${requestName(request)} — ${stack.folder}` : requestName(request);
  const annotations = opts.annotations && buildAnnotations(request, onPage, opts.annotations, title);
  const open = annotations && firstToReview(annotations, shown.map(([sha]) => sha).reverse());
  if (annotations && open) annotations.open = open;
  // Served, from the repository, which has every worktree's commits and branches.
  const gitDir = opts.served ? opts.repo : gitDirFor({ firefoxRepo: opts.repo }, stack.worktree);
  const page = await viewerPage({ command: opts.command, served: opts.served, gitDir, range: `${base}..${stack.branch}`, annotations, shas });
  return injectSendButton(page, { request: request.id, stack: stack.id, shas, ...(annotations ? { annotations, bugDrafts: bugDraftsOf(request, Object.values(shas)) } : {}) });
}

// One patch (a commit in its author's worktree) in stack-viewer; comments go back to its author.
export async function buildPatchView(opts: { repo: string; command: string[]; request: RequestState; patch: PatchView; annotations?: AnnotationIo; served?: Served }): Promise<string> {
  const { request, patch } = opts;
  if (!isRevName(patch.sha)) {
    throw new Error(`not a revision name: ${patch.sha}`);
  }
  const shas = { [patch.sha]: patch.id };
  const annotations = opts.annotations && buildAnnotations(request, shas, opts.annotations, `${shortTitle(patch)} — ${requestName(request)}`);
  const gitDir = opts.served ? opts.repo : gitDirFor({ firefoxRepo: opts.repo }, patch.worktree);
  const page = await viewerPage({ command: opts.command, served: opts.served, gitDir, range: `${patch.sha}^..${patch.sha}`, annotations, shas });
  return injectSendButton(page, { request: request.id, patch: patch.id, shas, ...(annotations ? { annotations, bugDrafts: bugDraftsOf(request, [patch.id]) } : {}) });
}

// What a try push would carry (the dry run's commits, newest first, in the worktree it pushes from), read-only.
export async function buildPushView(opts: { repo: string; command: string[]; cwd: string; commits: string[]; served?: Served }): Promise<string> {
  const newest = opts.commits[0];
  const oldest = opts.commits.at(-1)!;
  for (const rev of [newest, oldest]) {
    if (!isRevName(rev)) {
      throw new Error(`not a revision name: ${rev}`);
    }
  }
  const gitDir = opts.served ? opts.repo : gitDirFor({ firefoxRepo: opts.repo }, opts.cwd);
  return viewerPage({ command: opts.command, served: opts.served, gitDir, range: `${oldest}^..${newest}`, shas: {} });
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
// number) become commands right away, and Send, at the end of each patch's page beside Approve, sends what's new on
// the whole page since the last send: new comments, those on the commit message, the test plan and the whole patch
// included, and what you did to earlier ones. Each commit's frame then marks those sent, so Send stays usable. What
// happened shows on the Send of the commit it was done on.
const REVIEW_SCRIPT = `
(function () {
  var cfg = JSON.parse(document.getElementById("ff-review-config").textContent);
  var LABEL = ${JSON.stringify(SEND_LABEL)};
  function fullSha(sha) {
    for (var full in cfg.shas) {
      if (full.indexOf(sha) === 0 || sha.indexOf(full) === 0) return full;
    }
    return null;
  }
  // The commit's Send says it, for a while; busy, it can't be clicked.
  function say(sha, text, busy) {
    if (!cfg.annotations.commits[sha]) return;
    update(sha, function (a) {
      a.actions.forEach(function (x) { if (x.id === "send") { x.label = text; x.disabled = Boolean(busy); } });
    });
    if (busy) return;
    setTimeout(function () {
      update(sha, function (a) {
        a.actions.forEach(function (x) { if (x.id === "send" && x.label === text) x.label = LABEL; });
      });
    }, 2500);
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
    if (!patch) return;
    if (d.id === "send") {
      send(sha);
    } else if (d.id === "approve") {
      post({ cmd: "approve", patch: patch, sha: sha }).then(function () {
        update(sha, function (a) {
          a.status = { kind: "approved", label: "Approved", tooltip: "You approved it" };
          a.actions = a.actions.filter(function (x) { return x.id !== "approve"; });
        });
        say(sha, "Approved");
      }).catch(function (err) { say(sha, "Failed: " + err.message); });
    } else if (d.id === "bug-draft") {
      // A bug number (or its link), as the request page's field reads it; anything else is a comment on the draft.
      var text = String(d.value || "").trim();
      var m = /^(?:bug\\s*)?(\\d{4,8})$/i.exec(text) || /^https?:\\/\\/\\S*[?&\\/]id=(\\d{4,8})\\b\\S*$/.exec(text) || /^https?:\\/\\/bugzil\\.la\\/(\\d{4,8})$/.exec(text);
      if (m) {
        post({ cmd: "set-bug", patch: patch, bug: Number(m[1]) }).then(function () {
          bugSet(patch, Number(m[1]));
          say(sha, "Bug " + m[1] + " set: the factory puts it in the commit message");
        }).catch(function (err) { say(sha, "Failed: " + err.message); });
      } else {
        post({ cmd: "comment-bug-draft", patch: patch, text: text }).then(function () {
          say(sha, "Sent: the draft is revised after your comment");
        }).catch(function (err) { say(sha, "Failed: " + err.message); });
      }
    }
  });
  // Following a commit's "Bug XXXXXXX" link, or its panel's "Bug to file" (its bug to file): back here, bug-watch.js looks for the bug you filed.
  window.addEventListener("mdv-link", function (e) {
    var sha = fullSha(e.detail.commit);
    var patch = sha && cfg.shas[sha];
    var draft = patch && cfg.bugDrafts && cfg.bugDrafts[patch];
    if (draft && /^Bug X+$|Bug to file$/.test(e.detail.text)) window.ffBugWatch.add({ request: cfg.request, patch: patch, summary: draft.summary, title: draft.title });
  });
  // A bug given for a patch: it and the patches sharing its draft link their Bug XXXXXXX to it, under its number, until
  // the factory has put it in their commit messages; nothing left to file.
  function bugSet(patch, bug) {
    var draft = cfg.bugDrafts && cfg.bugDrafts[patch];
    var sharing = draft ? draft.patches : [patch];
    for (var sha in cfg.shas) {
      if (sharing.indexOf(cfg.shas[sha]) === -1 || !cfg.annotations.commits[sha]) continue;
      update(sha, function (a) {
        a.panels = (a.panels || []).filter(function (x) { return x.id !== "bug"; });
        a.titleLinks = [{ text: "Bug XXXXXXX", href: "https://bugzilla.mozilla.org/show_bug.cgi?id=" + bug, label: "Bug " + bug, tooltip: "The factory puts it in the commit message" }];
      });
    }
  }
  // bug-watch.js recorded it.
  window.addEventListener("ff-bug-recorded", function (e) {
    if (e.detail.request === cfg.request) bugSet(e.detail.patch, e.detail.bug);
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
        var item = { patch: patch, text: c.text, anchor: anchorOf(c), sha: sha };
        if (c.quote) item.quote = c.quote;
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
  function send(sha) {
    var c = collect();
    if (!c.comments.length && !c.responses.length) return say(sha, c.unknown ? "Comments on unknown commits" : "Nothing new to send");
    say(sha, "Sending…", true);
    post({ cmd: "review-send", comments: c.comments, responses: c.responses }).then(function () {
      for (var i = 0; i < c.marks.length; i++) if (typeof c.marks[i].win.mdvReviewMarkSent === "function") c.marks[i].win.mdvReviewMarkSent(c.marks[i].ids);
      var parts = [];
      if (c.comments.length) parts.push(c.comments.length + (c.comments.length === 1 ? " comment" : " comments"));
      if (c.responses.length) parts.push(c.responses.length + (c.responses.length === 1 ? " answer" : " answers"));
      say(sha, "Sent " + parts.join(" and "));
    }).catch(function (e) {
      say(sha, "Failed: " + e.message);
    });
  }
})();
`;

// The bugs to file of a page's patches (the first of those sharing a draft), by patch: what bug-watch.js looks for.
// The bugs to file, by the first patch sharing each draft, with the patches sharing it.
function bugDraftsOf(request: RequestState, patches: PatchId[]): Record<PatchId, { summary: string; title: string; patches: PatchId[] }> {
  return Object.fromEntries(
    [...new Set(patches)]
      .map((id) => request.patches[id])
      .filter((p) => (p.bug === null || p.bug === 0) && p.bugDraft && sameBugDraft(request, p.id)[0].id === p.id)
      .map((p) => [p.id, { summary: p.bugDraft!.summary, title: shortTitle(p), patches: sameBugDraft(request, p.id).map((x) => x.id) }]),
  );
}

export function injectSendButton(
  page: string,
  cfg: { request: string; stack?: string; patch?: string; shas: Record<string, string>; annotations?: Annotations; bugDrafts?: Record<PatchId, { summary: string; title: string; patches: PatchId[] }> },
): string {
  // Annotated, Send is each commit's own action, at the end of its page.
  const snippet =
    (cfg.annotations ? "" : `<button id="ff-send" type="button" style="position:fixed;right:12px;bottom:12px;z-index:1000;padding:6px 12px;border-radius:6px;border:1px solid #2a78d6;background:#2a78d6;color:#fff;font:13px system-ui,sans-serif;cursor:pointer">${SEND_LABEL}</button>`) +
    `<script type="application/json" id="ff-review-config">${jsonForScript(cfg)}</script>` +
    (cfg.annotations ? `<script src="/bug-watch.js"></script><script>${REVIEW_SCRIPT}</script>` : `<script>${SEND_SCRIPT}</script>`);
  const i = page.lastIndexOf("</body>");
  return i < 0 ? page + snippet : page.slice(0, i) + snippet + page.slice(i);
}
