/**
 * JettaChat embed loader.
 *
 * Drop one script tag on any page:
 *
 *   <script src="https://YOUR-JETTA-HOST/jettachat.js" defer
 *           data-surface="wordpress"></script>
 *
 * Or configure it explicitly before load (what a monday app view does, where
 * the account context is known and worth passing through):
 *
 *   window.JettaChatConfig = {
 *     surface: "monday",
 *     visitor: { mondayAccountSlug: "acme", app: "vlookup", email: "a@b.com" },
 *   };
 *
 * The loader owns three things the iframe can't: the launcher button, the
 * session in localStorage (third-party storage inside the iframe is blocked in
 * Safari and partitioned elsewhere), and the unread badge while collapsed.
 */
(function () {
  "use strict";

  if (window.__jettaChatLoaded) return;
  window.__jettaChatLoaded = true;

  var script = document.currentScript;
  var config = window.JettaChatConfig || {};
  var data = (script && script.dataset) || {};

  // Origin is taken from the script's own src so the embedding page never has
  // to be told where Jetta lives.
  var origin = (function () {
    try {
      return new URL(script.src).origin;
    } catch {
      return "";
    }
  })();

  var surface = config.surface || data.surface || "wordpress";
  var visitor = config.visitor || {};
  var STORAGE_KEY = "jettachat.session";

  function readSession() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    } catch {
      return null;
    }
  }

  function writeSession(session) {
    try {
      if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Private mode / storage disabled: the chat still works, it just won't
      // survive a reload. Not worth failing over.
    }
  }

  // ── UI ───────────────────────────────────────────────────────────
  var open = false;
  var unread = 0;

  var root = document.createElement("div");
  root.setAttribute("data-jettachat", "");
  root.style.cssText = "position:fixed;bottom:20px;right:20px;z-index:2147483000;";

  var panel = document.createElement("div");
  panel.style.cssText = [
    "width:380px;height:560px;max-width:calc(100vw - 40px);max-height:calc(100vh - 120px)",
    "border-radius:16px;overflow:hidden;background:#fff",
    "box-shadow:0 12px 48px rgba(0,0,0,.18)",
    "display:none;margin-bottom:12px",
    "opacity:0;transform:translateY(8px);transition:opacity .18s ease,transform .18s ease",
  ].join(";");

  var frame = document.createElement("iframe");
  frame.src = origin + "/chat";
  frame.title = "Jetta support chat";
  frame.style.cssText = "width:100%;height:100%;border:0;display:block;";
  panel.appendChild(frame);

  var launcher = document.createElement("button");
  launcher.type = "button";
  launcher.setAttribute("aria-label", "Open support chat");
  launcher.style.cssText = [
    "width:56px;height:56px;border-radius:50%;border:0;cursor:pointer",
    "background:#171717;color:#fff;float:right",
    "box-shadow:0 6px 20px rgba(0,0,0,.22)",
    "display:flex;align-items:center;justify-content:center",
    "transition:transform .15s ease",
  ].join(";");
  launcher.innerHTML =
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';
  launcher.onmouseenter = function () {
    launcher.style.transform = "scale(1.06)";
  };
  launcher.onmouseleave = function () {
    launcher.style.transform = "scale(1)";
  };

  var badge = document.createElement("span");
  badge.style.cssText = [
    "position:absolute;top:-2px;right:-2px;min-width:20px;height:20px",
    "border-radius:10px;background:#dc2626;color:#fff",
    "font:600 11px/20px system-ui,sans-serif;text-align:center;padding:0 5px",
    "display:none;pointer-events:none",
  ].join(";");

  var launcherWrap = document.createElement("div");
  launcherWrap.style.cssText = "position:relative;float:right;";
  launcherWrap.appendChild(launcher);
  launcherWrap.appendChild(badge);

  root.appendChild(panel);
  root.appendChild(launcherWrap);

  function renderBadge() {
    badge.style.display = unread > 0 && !open ? "block" : "none";
    badge.textContent = unread > 9 ? "9+" : String(unread);
  }

  function setOpen(next) {
    open = next;
    launcher.setAttribute("aria-label", open ? "Close support chat" : "Open support chat");
    if (open) {
      unread = 0;
      renderBadge();
      panel.style.display = "block";
      // Next frame, so the transition has a "from" state to animate out of.
      requestAnimationFrame(function () {
        panel.style.opacity = "1";
        panel.style.transform = "translateY(0)";
      });
    } else {
      panel.style.opacity = "0";
      panel.style.transform = "translateY(8px)";
      setTimeout(function () {
        if (!open) panel.style.display = "none";
      }, 180);
    }
  }

  launcher.addEventListener("click", function () {
    setOpen(!open);
  });

  // ── Frame handshake ──────────────────────────────────────────────
  window.addEventListener("message", function (event) {
    if (origin && event.origin !== origin) return;
    if (event.source !== frame.contentWindow) return;
    var msg = event.data || {};

    if (msg.type === "jettachat:ready") {
      frame.contentWindow.postMessage(
        {
          type: "jettachat:init",
          session: readSession(),
          surface: surface,
          visitor: visitor,
          pageUrl: location.href,
        },
        origin,
      );
    } else if (msg.type === "jettachat:session") {
      writeSession(msg.session);
    } else if (msg.type === "jettachat:unread") {
      if (!open) {
        unread += 1;
        renderBadge();
      }
    } else if (msg.type === "jettachat:close") {
      setOpen(false);
    }
  });

  function mount() {
    document.body.appendChild(root);
    if (config.autoOpen) setOpen(true);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }

  // Small public API for the host page (a monday app can open the chat from
  // its own UI, or hand us identity it learns after load).
  window.JettaChat = {
    open: function () {
      setOpen(true);
    },
    close: function () {
      setOpen(false);
    },
    identify: function (next) {
      visitor = Object.assign({}, visitor, next || {});
    },
    reset: function () {
      writeSession(null);
    },
  };
})();
