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
  function busy(el) {
    var a = document.activeElement;
    return a && el.contains(a) && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT") && a.value !== "";
  }

  function refreshMain() {
    var open = Array.prototype.map.call(document.querySelectorAll("details.req[open]"), function (d) {
      return d.dataset.request;
    });
    var url = "/fragments/main" + (open.length === 1 ? "?open=" + encodeURIComponent(open[0]) : "");
    return fetchText(url).then(function (text) {
      var main = document.getElementById("main");
      if (main.contains(document.activeElement) && document.activeElement.value) return;
      main.replaceChildren(parse(text));
      open.forEach(function (id) {
        var el = requestElement(id);
        if (el && el.tagName === "DETAILS" && !el.open) {
          el.open = true;
        }
      });
    });
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
    return fetchText("/fragments/requests/" + encodeURIComponent(id) + (open ? "?open=1" : ""))
      .then(function (text) {
        var fresh = parse(text).firstElementChild;
        // A request that moved between active, queued and finished needs the whole list.
        if (!fresh || fresh.dataset.section !== el.dataset.section) return refreshMain();
        el.replaceWith(fresh);
      })
      .catch(function (e) {
        if (e.status === 404) el.remove();
      });
  }

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

  // Clicks in a ⚑ area that aren't on a control mustn't fold the request.
  document.addEventListener("click", function (event) {
    var t = event.target;
    if (t.closest && t.closest("summary .action") && !t.closest("button, a, input, textarea, select, label")) {
      event.preventDefault();
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
        flash(form, "Sent", "flash");
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

  var connectedOnce = false;
  function connect() {
    var source = new EventSource("/events");
    source.addEventListener("open", function () {
      // After a server restart or a network drop, changes may have been missed.
      if (connectedOnce) {
        refreshMain();
        refreshStrip();
      }
      connectedOnce = true;
    });
    source.addEventListener("changed", function (event) {
      refreshRequest(JSON.parse(event.data));
      refreshStrip();
    });
  }
  connect();
})();
