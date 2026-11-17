// The bug you filed from a "Bug to file" link, recorded without typing its number: following the link keeps the draft
// it was for (localStorage, shared by the factory's tabs); coming back to the page (it becomes visible, or gets the
// focus) asks the server, at most every 15 s and while links followed in the last 3 h wait, which bugs you filed since
// (one Bugzilla search, src/server/bug-match.ts). A match is sent as the bug box sends it, and said in a notice where
// you can correct it. Used by the factory's pages (links with data-bug-draft) and its stack-viewer pages (their
// script calls ffBugWatch.add on mdv-link).
(function () {
  "use strict";
  var KEY = "ff-bugs-to-file";
  var MAX_AGE = 3 * 3600 * 1000;
  var EVERY = 15 * 1000;

  function load() {
    try {
      var list = JSON.parse(localStorage.getItem(KEY) || "[]");
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }
  function save(list) {
    if (list.length) localStorage.setItem(KEY, JSON.stringify(list));
    else localStorage.removeItem(KEY);
  }
  function live() {
    var now = Date.now();
    return load().filter(function (p) {
      return now - Date.parse(p.t) < MAX_AGE;
    });
  }
  function remove(keys) {
    save(
      live().filter(function (p) {
        return keys.indexOf(p.key) === -1;
      }),
    );
  }

  // {request, patch ("meta" for the meta bug), summary, title}
  function add(draft) {
    var key = draft.request + "\n" + draft.patch;
    var list = live().filter(function (p) {
      return p.key !== key;
    });
    list.push({ key: key, request: draft.request, patch: draft.patch, summary: draft.summary, title: draft.title, t: new Date().toISOString() });
    save(list);
  }

  function post(url, body) {
    return fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) }).then(function (r) {
      return r.json().then(function (b) {
        if (!r.ok) throw new Error(b.error || r.statusText);
        return b;
      });
    });
  }

  var last = 0;
  var running = false;
  function check() {
    var list = live();
    save(list);
    if (!list.length || running || Date.now() - last < EVERY) return Promise.resolve();
    last = Date.now();
    running = true;
    return post("/api/bugs/filed", { pending: list })
      .then(function (b) {
        remove(b.settled);
        return b.matches.reduce(function (done, m) {
          return done.then(function () {
            return record(m);
          });
        }, Promise.resolve());
      })
      .catch(function (e) {
        console.warn("Looking for the bugs you filed: " + e.message);
      })
      .then(function () {
        running = false;
      });
  }

  // As the bug box sends it (set-bug; patch "meta" for the meta bug). Taken off the list first: another tab coming
  // back at the same time doesn't send it again.
  function record(m) {
    remove([m.key]);
    return post("/api/commands", { cmd: "set-bug", request: m.request, patch: m.patch, bug: m.bug }).then(function () {
      notice(m, m.bug);
      window.dispatchEvent(new CustomEvent("ff-bug-recorded", { detail: { request: m.request, patch: m.patch, bug: m.bug } }));
    });
  }

  // "Bug N recorded for <title>", with a field to give the right number instead, and a close button.
  var box = null;
  function notice(m, bug) {
    if (!box) {
      box = document.createElement("div");
      box.id = "ff-bug-notices";
      box.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:1001;display:flex;flex-direction:column;gap:6px;font:13px system-ui,sans-serif";
      document.body.appendChild(box);
    }
    var line = document.createElement("div");
    line.className = "ff-bug-notice";
    line.style.cssText = "background:#fff;color:#222;border:1px solid #2a78d6;border-radius:6px;padding:6px 10px;box-shadow:0 2px 6px rgba(0,0,0,.2);display:flex;gap:8px;align-items:center";
    var text = document.createElement("span");
    text.textContent = "Bug " + bug + " recorded for " + m.title;
    var field = document.createElement("input");
    field.type = "text";
    field.placeholder = "Not it? The right number";
    field.size = 22;
    field.addEventListener("keydown", function (event) {
      if (event.key !== "Enter") return;
      var right = /(\d{4,8})\s*$/.exec(field.value.trim());
      if (!right) return;
      post("/api/commands", { cmd: "set-bug", request: m.request, patch: m.patch, bug: Number(right[1]) }).then(
        function () {
          line.remove();
          notice(m, Number(right[1]));
          window.dispatchEvent(new CustomEvent("ff-bug-recorded", { detail: { request: m.request, patch: m.patch, bug: Number(right[1]) } }));
        },
        function (e) {
          text.textContent = "Couldn't change it: " + e.message;
        },
      );
    });
    var close = document.createElement("button");
    close.type = "button";
    close.textContent = "×";
    close.title = "Close";
    close.addEventListener("click", function () {
      line.remove();
    });
    line.append(text, field, close);
    box.appendChild(line);
  }

  // The factory's own links say what they file.
  function followed(event) {
    var a = event.target.closest && event.target.closest("a[data-bug-draft]");
    if (!a || event.button > 1) return;
    try {
      add(JSON.parse(a.dataset.bugDraft));
    } catch (e) {
      // not one of ours
    }
  }
  document.addEventListener("click", followed);
  document.addEventListener("auxclick", followed);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") check();
  });
  window.addEventListener("focus", check);

  window.ffBugWatch = { add: add, check: check };
})();
