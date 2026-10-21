// Live updates, command forms without page reloads, copy-to-clipboard, and presence.
// Served as is; the page works without it (forms post and come back).
(function () {
  "use strict";

  function parse(htmlText) {
    var t = document.createElement("template");
    t.innerHTML = htmlText.trim();
    return t.content;
  }

  function fetchText(url) {
    return fetch(url, { headers: { Accept: "text/html" } }).then(function (r) {
      if (!r.ok) {
        var e = new Error(r.statusText);
        e.status = r.status;
        throw e;
      }
      return r.text();
    });
  }

  function requestElement(id) {
    return document.querySelector('[data-request="' + CSS.escape(id) + '"]');
  }

  // Don't swap a request out from under what you're typing; it's refreshed when
  // you leave the field.
  var pending = new Set();
  // Re-rendering waits while you type, and while anything you typed isn't sent yet, focused or not: it would be lost.
  function busy(el) {
    var a = document.activeElement;
    if (a && el.contains(a) && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT") && a.value !== "") return true;
    return Array.prototype.some.call(el.querySelectorAll("input[type=text], textarea"), function (i) {
      return i.value !== "" && i.value !== i.defaultValue;
    });
  }

  // What you opened (requests, and folded parts of them: rows, closed groups, an agent's activity) stays
  // open when a request is re-rendered, and in the URL's hash, so a reload (after the server restarted on
  // new code) opens it again.
  var opened = new Set(
    location.hash
      .slice(1)
      .split(",")
      .filter(Boolean)
      .map(decodeURIComponent)
  );
  function keyOf(d) {
    if (d.matches("details.req")) return "r " + d.dataset.request;
    var req = d.dataset.fold && d.closest("[data-request]");
    return req ? req.dataset.request + " " + d.dataset.fold : null;
  }
  // Inside a closed request nothing counts as open, and a part that's gone (a group row replaced by its
  // patch's) is forgotten.
  function pruneOpened(root) {
    opened.forEach(function (key) {
      var sp = key.indexOf(" ");
      var request = key.slice(0, sp);
      if (request === "r") return;
      if (!opened.has("r " + request)) {
        opened.delete(key);
        return;
      }
      var el = requestElement(request);
      if (el && root.contains(el) && !el.querySelector(":scope > .rbody[data-lazy]")) {
        var present = Array.prototype.some.call(el.querySelectorAll("details[data-fold]"), function (d) {
          return d.dataset.fold === key.slice(sp + 1);
        });
        if (!present) opened.delete(key);
      }
    });
  }
  function saveOpened() {
    pruneOpened(document);
    history.replaceState(null, "", location.pathname + location.search + (opened.size ? "#" + Array.from(opened).map(encodeURIComponent).join(",") : ""));
  }
  function reopenFolds(root) {
    root.querySelectorAll("details.req, details[data-fold]").forEach(function (d) {
      if (!d.open && opened.has(keyOf(d))) d.open = true;
      // The page of one request comes with it open.
      else if (d.open && d.matches("details.req")) opened.add(keyOf(d));
    });
    saveOpened();
  }
  document.addEventListener(
    "toggle",
    function (event) {
      var d = event.target;
      var key = d.matches && keyOf(d);
      if (!key || d.open === opened.has(key)) return;
      if (d.open) opened.add(key);
      else opened.delete(key);
      saveOpened();
    },
    true
  );

  // Changes come in bursts and their answers can arrive out of order: one sequence across the main list and
  // the requests in it, so an older answer never replaces newer content. A failed latest fetch is retried.
  var seq = 0;
  var mainLatest = 0;
  var mainShown = 0;
  var retryMain = false;
  var retryRequests = new Set();
  function refreshMain() {
    var open = Array.prototype.map.call(document.querySelectorAll("details.req[open]"), function (d) {
      return d.dataset.request;
    });
    var url = "/fragments/main" + (open.length === 1 ? "?open=" + encodeURIComponent(open[0]) : "");
    var s = (mainLatest = ++seq);
    retryMain = false;
    return fetchText(url).then(
      function (text) {
        if (s !== mainLatest) return;
        var main = document.getElementById("main");
        if (busy(main)) {
          retryMain = true;
          return;
        }
        var fresh = parse(text);
        // Requests refreshed since this was asked for keep their newer version.
        main.querySelectorAll("[data-request][data-seq]").forEach(function (el) {
          var old = +el.dataset.seq > s && fresh.querySelector('[data-request="' + CSS.escape(el.dataset.request) + '"]');
          if (old) old.replaceWith(el);
        });
        main.replaceChildren(fresh);
        mainShown = s;
        reopenFolds(main);
      },
      function () {
        if (s === mainLatest) retryMain = true;
      }
    );
  }

  var latest = {};
  var shown = {}; // the last fragment text put on the page, per request
  // Changes come in bursts (a try push's progress, an agent's events): one refresh per request a second at most,
  // and none when what the server renders hasn't changed.
  var queued = {};
  function scheduleRefresh(id) {
    if (queued[id]) return;
    queued[id] = setTimeout(function () {
      delete queued[id];
      refreshRequest(id);
    }, 1000);
  }
  function refreshRequest(id) {
    var el = requestElement(id);
    // Queued and finished requests are one-line rows of the main fragment.
    if (!el || el.dataset.section !== "active") return refreshMain();
    if (busy(el)) {
      pending.add(id);
      return Promise.resolve();
    }
    var open = el.tagName === "DETAILS" && el.open;
    var s = (latest[id] = ++seq);
    retryRequests.delete(id);
    return fetchText("/fragments/requests/" + encodeURIComponent(id) + (open ? "?open=1" : ""))
      .then(function (text) {
        if (s !== latest[id] || s < mainShown) return;
        el = requestElement(id);
        if (!el) return;
        if (shown[id] === text) return;
        var fresh = parse(text).firstElementChild;
        // A request that moved between active, queued and finished needs the whole list.
        if (!fresh || fresh.dataset.section !== el.dataset.section) return refreshMain();
        shown[id] = text;
        fresh.dataset.seq = s;
        // An agent's conversation already on the page carries over, rather than blanking until it reloads.
        fresh.querySelectorAll("details[data-watch] .activity").forEach(function (box) {
          var fold = box.closest("details[data-watch]").dataset.fold;
          var old = el.querySelector('details[data-watch][data-fold="' + CSS.escape(fold) + '"] .activity');
          if (old) {
            box.innerHTML = old.innerHTML;
            box.dataset.text = old.dataset.text || "";
          }
        });
        el.replaceWith(fresh);
        reopenFolds(fresh);
      })
      .catch(function (e) {
        if (e.status === 404) el.remove();
        else if (s === latest[id]) retryRequests.add(id);
      });
  }
  setInterval(function () {
    if (retryMain) refreshMain();
    retryRequests.forEach(function (id) {
      refreshRequest(id);
    });
  }, 5000);

  function refreshStrip() {
    return fetchText("/fragments/strip").then(function (text) {
      var strip = document.getElementById("strip");
      if (strip) strip.replaceWith(parse(text));
    });
  }

  document.addEventListener("focusout", function () {
    setTimeout(function () {
      pending.forEach(function (id) {
        var el = requestElement(id);
        if (!el || !busy(el)) {
          pending.delete(id);
          refreshRequest(id);
        }
      });
    }, 0);
  });

  // A collapsed request comes without its body, to keep the overview small.
  document.addEventListener(
    "toggle",
    function (event) {
      var d = event.target;
      if (!d.matches || !d.matches("details.req") || !d.open) return;
      var body = d.querySelector(":scope > .rbody[data-lazy]");
      if (body) refreshRequest(d.dataset.request);
    },
    true
  );

  // An agent's conversation: loaded when its job line opens, then reloaded while it runs and stays open.
  function loadActivity(d) {
    fetch(d.dataset.watch)
      .then(function (r) {
        return r.text();
      })
      .then(function (text) {
        var box = d.querySelector(".activity");
        // Unchanged: left alone (replacing it would reset its scrollbars and selection).
        if (box.dataset.text === text) return;
        box.dataset.text = text;
        // Its folded parts (tool calls, the prompt) stay as you left them.
        var open = Array.prototype.map.call(box.querySelectorAll("details[data-more][open]"), function (x) {
          return x.dataset.more;
        });
        var expanded = box.querySelector("[data-expand].open");
        box.innerHTML = text;
        box.querySelectorAll("details[data-more]").forEach(function (x) {
          if (open.indexOf(x.dataset.more) >= 0) x.open = true;
        });
        if (expanded) box.querySelector("[data-expand]").classList.add("open");
      })
      .catch(function () {});
  }
  document.addEventListener(
    "toggle",
    function (event) {
      var d = event.target;
      if (d.matches && d.matches("details[data-watch]") && d.open) loadActivity(d);
      // A try push's jobs, once: its dry run doesn't change.
      if (d.matches && d.matches("details[data-tasks]") && d.open) {
        var box = d.querySelector(".ptasks");
        if (box.dataset.loaded) return;
        fetchText(d.dataset.tasks)
          .then(function (text) {
            box.innerHTML = text;
            box.dataset.loaded = "1";
          })
          .catch(function (e) {
            box.textContent = "Couldn't load the jobs (" + e.message + "): reopen to try again.";
          });
      }
    },
    true
  );
  setInterval(function () {
    if (document.visibilityState === "visible") document.querySelectorAll("details[data-watch][data-live][open]").forEach(loadActivity);
  }, 3000);

  // Clicks in a ⚑ area that aren't on a control mustn't fold the request.
  document.addEventListener("click", function (event) {
    var t = event.target;
    if (!t.closest) return;
    if (t.closest("summary .action") && !t.closest("button, a, input, textarea, select, label")) {
      event.preventDefault();
    }
    var clamped = t.closest("[data-expand]");
    if (clamped) clamped.classList.toggle("open");
    // Revise… opens its push's row at the box.
    var revise = t.closest("[data-revise]");
    if (revise) {
      var row = revise.closest("details.row");
      row.open = true;
      row.querySelector("form.revise textarea").focus();
    }
  });

  document.addEventListener("submit", function (event) {
    var form = event.target;
    if (!form.classList.contains("cmd")) return;
    event.preventDefault();
    var button = event.submitter || form.querySelector("button");
    if (button) button.disabled = true;
    fetch(form.action, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(new FormData(form)),
    })
      .then(function (r) {
        return r.json().then(function (body) {
          if (!r.ok) throw new Error(body.error || r.statusText);
        });
      })
      .then(function () {
        form.querySelectorAll("input[type=text], textarea").forEach(function (i) {
          i.value = "";
        });
        // A ⚑ you dismissed goes away now, not at the next refresh.
        var dismissed = /"cmd":"dismiss"/.test((form.querySelector("input[name=command]") || {}).value || "");
        var flag = dismissed && form.closest("[data-key]");
        if (flag) flag.remove();
        else flash(form, "Sent", "flash");
      })
      .catch(function (e) {
        flash(form, e.message, "error");
      })
      .finally(function () {
        if (button) button.disabled = false;
      });
  });

  function flash(form, text, cls) {
    var span = document.createElement("span");
    span.className = cls;
    span.textContent = text;
    form.appendChild(span);
    setTimeout(function () {
      span.remove();
    }, cls === "error" ? 6000 : 1500);
  }

  document.addEventListener("click", function (event) {
    var button = event.target.closest && event.target.closest("[data-copy]");
    if (!button) return;
    // Copy buttons inside a request's summary line mustn't fold it.
    event.preventDefault();
    var area = document.getElementById(button.dataset.copy);
    if (!area) return;
    // The moz-phab command's form tells the factory you copied it.
    var form = button.closest("form.cmd");
    if (form) form.requestSubmit();
    var done = function () {
      var label = button.textContent;
      button.textContent = "Copied";
      setTimeout(function () {
        button.textContent = label;
      }, 1200);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(area.value).then(done);
    } else {
      // The page is often opened over plain http from another machine, where the
      // clipboard API isn't available.
      // A hidden textarea can't be selected.
      var hidden = area.hidden;
      area.hidden = false;
      area.select();
      document.execCommand("copy");
      area.hidden = hidden;
      done();
    }
  });

  // Tells the orchestrator you're here: it polls Phabricator only while you are
  // (docs/ORCHESTRATOR.md). Not a user action, so no feedback, and failures are
  // ignored: the next one comes at the next visibility change or tick.
  var PRESENCE_MS = 15 * 60 * 1000;
  var presenceTimer = null;
  var lastVisibleSent = -Infinity;
  function sendPresence() {
    var visible = document.visibilityState === "visible";
    // Flipping between tabs shouldn't append a command each time.
    if (visible && Date.now() - lastVisibleSent < 60 * 1000) return;
    if (visible) lastVisibleSent = Date.now();
    fetch("/api/commands", {
      method: "POST",
      // Lets the "hidden" one go out when the tab is closing.
      keepalive: true,
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ cmd: "presence", visible: visible }),
    }).catch(function () {});
  }
  function onVisibilityChange() {
    clearInterval(presenceTimer);
    presenceTimer = null;
    sendPresence();
    if (document.visibilityState === "visible") presenceTimer = setInterval(sendPresence, PRESENCE_MS);
  }
  document.addEventListener("visibilitychange", onVisibilityChange);
  if (document.visibilityState === "visible") onVisibilityChange();

  // Same output as formatDuration in pages/common.ts.
  function formatDuration(ms) {
    var s = Math.round(ms / 1000);
    if (s < 60) return s + " s";
    var min = Math.round(s / 60);
    if (min < 60) return min + " min";
    var h = ms / 3600000;
    return h < 10 ? h.toFixed(1).replace(/\.0$/, "") + " h" : Math.round(h) + " h";
  }
  setInterval(function () {
    document.querySelectorAll("[data-since]").forEach(function (el) {
      el.textContent = formatDuration(Date.now() - Date.parse(el.getAttribute("data-since")));
    });
  }, 5000);

  // After the server restarted on new code, the page reloads, once nothing you typed would be lost.
  // The server renders its id on the page, so a page from an earlier run reloads on its first hello.
  var bootId = document.body.dataset.boot;
  function typing() {
    // Drafted replies come filled in: only a focused field, or one you changed, counts, and only with text.
    return Array.prototype.some.call(document.querySelectorAll("input[type=text], textarea"), function (i) {
      return i.value !== "" && (i === document.activeElement || i.value !== i.defaultValue);
    });
  }
  var reloading = false;
  function reloadWhenIdle() {
    reloading = true;
    if (typing()) setTimeout(reloadWhenIdle, 5000);
    else location.reload();
  }

  reopenFolds(document);

  var connectedOnce = false;
  function connect() {
    var source = new EventSource("/events");
    source.addEventListener("hello", function (event) {
      if (JSON.parse(event.data) !== bootId && !reloading) reloadWhenIdle();
    });
    source.addEventListener("open", function () {
      // After a server restart or a network drop, changes may have been missed.
      if (connectedOnce) {
        refreshMain();
        refreshStrip();
      }
      connectedOnce = true;
    });
    source.addEventListener("changed", function (event) {
      scheduleRefresh(JSON.parse(event.data));
      refreshStrip();
    });
  }
  connect();
})();
