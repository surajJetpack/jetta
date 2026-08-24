/**
 * JettaChat embed loader.
 *
 * Drop one script tag on any page:
 *
 *   <script src="https://YOUR-JETTA-HOST/jettachat.js" defer
 *           data-surface="wordpress"></script>
 *
 * On GetSign's own site, name the app so the widget wears the GetSign skin and
 * answers from the GetSign knowledge base only:
 *
 *   <script src="https://YOUR-JETTA-HOST/jettachat.js" defer
 *           data-surface="wordpress" data-app="getsign"></script>
 *
 * Or configure it explicitly before load (what a monday app view does, where
 * the account context is known and worth passing through):
 *
 *   window.JettaChatConfig = {
 *     surface: "monday",
 *     visitor: { mondayAccountSlug: "acme", app: "vlookup", email: "a@b.com" },
 *   };
 *
 * WHERE THE LAUNCHER SITS is settable per embed, because only the embedding
 * page knows what else is in that corner:
 *
 *   window.JettaChatConfig = {
 *     // Optional. Defaults: 20px from each edge — but 88px from the bottom on
 *     // surface "monday", which is already occupied by monday's AI sidekick.
 *     launcher: { position: "left", offsetX: 20, offsetY: 88 },
 *   };
 *
 * This exists for the case a console setting cannot answer. The side is a
 * console field, but it is keyed by BRAND — one value for GetSign's site and
 * GetSign's monday view alike — and inside a monday app view the thing being
 * collided with belongs to the parent page. That is also why moving is the
 * only fix available: the launcher lives in an iframe, so no z-index of ours
 * can stack above the host's own floating UI, whatever value it carries.
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

  /**
   * Launcher placement, as the embedding page asked for it.
   *
   * Clamped rather than trusted: a page meaning `offsetY: 88` and passing
   * `"88px"` or `8800` would otherwise park the launcher somewhere nobody can
   * click, which reads as a broken install rather than a bad number. An absent
   * or unusable value falls back to the default edge for the surface (see
   * DEFAULT_EDGE_Y), and an absent `position` leaves the console's brand
   * setting in charge.
   */
  var placement = config.launcher || {};
  /**
   * How high the launcher sits when the page hasn't said.
   *
   * 20px everywhere, except inside a monday app view — where that corner is
   * not ours. monday puts its own AI sidekick there, a floating circle at the
   * same size in the same spot, and at 20px Jetta's launcher lands completely
   * underneath it: invisible, unclickable, and indistinguishable from a widget
   * that failed to load. Nothing on our side can win that fight with a
   * z-index, because we are in an iframe on their page.
   *
   * 88px stacks Jetta a full launcher height (56px) plus a gap above the
   * sidekick rather than beside it — which works whichever corner the app puts
   * us in, and is the same offset the install guide has always recommended for
   * clearing a bottom bar. A page that knows its own furniture still overrides
   * it by passing `offsetY`.
   */
  var DEFAULT_EDGE_Y = surface === "monday" ? 88 : 20;
  function edge(v, fallback) {
    var n = Number(v);
    return isFinite(n) && n >= 0 ? Math.min(n, 240) : fallback;
  }
  var EDGE_X = edge(placement.offsetX, 20);
  var EDGE_Y = edge(placement.offsetY, DEFAULT_EDGE_Y);
  var SIDE = placement.position === "left" || placement.position === "right" ? placement.position : null;

  /**
   * Which brand this page belongs to.
   *
   * GetSign is served by the same Jetta with a different skin and a knowledge
   * base scoped to GetSign alone, so the answer has to be known before the
   * frame renders — it decides the greeting the visitor sees first. The
   * hostname check is the safety net: it keeps working on an install snippet
   * that was pasted before `data-app` existed.
   */
  var product =
    visitor.app === "getsign" || data.app === "getsign" || /(^|\.)getsign\.io$/i.test(location.hostname)
      ? "getsign"
      : "";
  // Pin it on the visitor too. Server-side this becomes the product hint, and
  // a hinted product is treated as ground truth — so the scoping holds from
  // the first message rather than waiting on what the visitor happens to type.
  if (product && !visitor.app) visitor = Object.assign({}, visitor, { app: product });
  var STORAGE_KEY = "jettachat.session";
  var AUTO_OPEN_KEY = "jettachat.autoopened";
  var BRAND_KEY = "jettachat.brand";

  /**
   * The launcher's colour, logo, label and side.
   *
   * The loader has no settings of its own and deliberately does not fetch any:
   * styling one button is not worth a ~125 kB request (the avatar dominates
   * it) on every page view of a marketing site. The frame already fetches the
   * settings to render itself, so it posts them out here — and the last set is
   * cached, because a launcher that is black for a moment and then turns brand
   * colour on every page load looks broken rather than branded.
   */
  var brand = (function () {
    try {
      return JSON.parse(localStorage.getItem(BRAND_KEY) || "null") || {};
    } catch {
      return {};
    }
  })();

  /**
   * Don't interrupt the same person twice in a day.
   *
   * A chat that opens itself is already pushing its luck; one that does it on
   * every page of a site the visitor is browsing is an advert. The stamp lives
   * on the PARENT page, not in the iframe, for the same reason the session
   * does — third-party storage inside the frame is partitioned or blocked, so
   * an iframe-side memory would forget on every page and nag on every page.
   */
  var AUTO_OPEN_EVERY_MS = 24 * 60 * 60 * 1000;

  function autoOpenedRecently() {
    try {
      var last = Number(localStorage.getItem(AUTO_OPEN_KEY) || 0);
      return last > 0 && Date.now() - last < AUTO_OPEN_EVERY_MS;
    } catch {
      // Storage blocked (private mode). Treat as "already interrupted" — the
      // safe failure is not opening, because we would have no way to remember
      // that we did and would do it again on the next page.
      return true;
    }
  }

  function rememberAutoOpen() {
    try {
      localStorage.setItem(AUTO_OPEN_KEY, String(Date.now()));
    } catch {
      // Nothing to do; the check above already fails closed.
    }
  }

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
  // Set the moment the visitor closes the panel themselves. Someone who has
  // just dismissed the chat has answered the question; re-opening on a timer
  // would be arguing with them.
  var dismissed = false;

  var root = document.createElement("div");
  root.setAttribute("data-jettachat", "");
  root.style.cssText =
    "position:fixed;bottom:" + EDGE_Y + "px;right:" + EDGE_X + "px;z-index:2147483000;";

  // The one piece of real CSS the loader owns. Keyframes cannot be written as
  // inline styles, and a reply arriving in the corner of a page someone is
  // reading deserves one visible movement — a badge that silently changes from
  // nothing to "1" is invisible in peripheral vision, which is the only vision
  // pointed at it. One movement, not a loop: looping is how widgets nag.
  var motion = document.createElement("style");
  motion.textContent =
    "@keyframes jettachat-pop{0%{transform:scale(.4)}55%{transform:scale(1.2)}100%{transform:scale(1)}}" +
    "@keyframes jettachat-nudge{0%,100%{transform:translateY(0)}35%{transform:translateY(-5px)}70%{transform:translateY(2px)}}" +
    "@media (prefers-reduced-motion:reduce){[data-jettachat] *{animation:none!important}}";
  (document.head || document.documentElement).appendChild(motion);

  var panel = document.createElement("div");
  panel.style.cssText = [
    // The cap subtracts the launcher, the gap and whatever the page pushed the
    // widget up by — otherwise a raised launcher opens a panel that runs off
    // the top of a short app view.
    "width:380px;height:560px;max-width:calc(100vw - 40px);max-height:calc(100vh - " +
      (100 + EDGE_Y) +
      "px)",
    "border-radius:16px;overflow:hidden;background:#fff",
    "box-shadow:0 12px 48px rgba(0,0,0,.18)",
    "display:none;margin-bottom:12px",
    "opacity:0;transform:translateY(8px);transition:opacity .18s ease,transform .18s ease",
  ].join(";");

  var frame = document.createElement("iframe");
  frame.src = origin + "/chat" + (product ? "?product=" + encodeURIComponent(product) : "");
  frame.title = "Jetta support chat";
  frame.style.cssText = "width:100%;height:100%;border:0;display:block;";
  panel.appendChild(frame);

  /**
   * The launcher is a pill, not a circle.
   *
   * It collapses to a 56px circle when there is no label to show, which is
   * what it always used to be — but `launcherLabel` is a field someone sets in
   * the console and watches appear in the preview, and until now the only
   * place it landed was a `title` attribute. A tooltip is not an answer to
   * "what does this button say": it needs a hover, it never appears on a
   * phone, and a visitor who is deciding whether to ask for help is exactly
   * the person who will not go looking for it.
   */
  var launcher = document.createElement("button");
  launcher.type = "button";
  launcher.setAttribute("aria-label", "Open support chat");
  launcher.style.cssText = [
    "min-width:56px;height:56px;border-radius:28px;border:0;cursor:pointer;padding:0;overflow:hidden",
    "background:#171717;color:#fff;float:right",
    "box-shadow:0 6px 20px rgba(0,0,0,.22)",
    "display:flex;align-items:center;justify-content:center",
    "transition:transform .15s ease",
  ].join(";");

  // The mark — avatar or speech bubble — stays a 56px circle at one end of the
  // pill, so the button keeps its shape whether or not a label is beside it.
  // It is its own element rather than the button's own content because the
  // avatar is sized at 100% and would otherwise stretch across the label.
  var icon = document.createElement("span");
  icon.style.cssText = [
    "width:56px;height:56px;flex:0 0 56px;border-radius:50%;overflow:hidden",
    "display:flex;align-items:center;justify-content:center",
  ].join(";");

  var label = document.createElement("span");
  label.style.cssText = [
    "display:none;white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis",
    "font:600 14px/1 system-ui,-apple-system,'Segoe UI',sans-serif;color:inherit",
  ].join(";");

  launcher.appendChild(icon);
  launcher.appendChild(label);

  var BUBBLE_SVG =
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';

  /**
   * Paint the launcher from whatever brand we have. Called once with the
   * cached values and again when the frame reports the live ones.
   *
   * The avatar replaces the speech bubble rather than sitting beside it: the
   * mark is one 56px circle, and a logo says more about who is answering than
   * a generic bubble does. An avatar that fails to load falls back to the
   * bubble rather than leaving an empty circle. The label, when there is one,
   * goes beside that circle — see paintLabel below.
   */
  function paintLauncher() {
    if (/^#[0-9a-f]{6}$/i.test(brand.accentColor || "")) {
      launcher.style.background = brand.accentColor;
    }
    // Assigned every paint, including to nothing.
    //
    // This used to only ever be set, never cleared — so a label removed in the
    // console kept hanging off a hover. The cached brand paints first and puts
    // the old caption in the tooltip; the live brand arrives with no label,
    // folds the pill away, and left the tooltip exactly where it was.
    if (brand.launcherLabel) launcher.title = brand.launcherLabel;
    else launcher.removeAttribute("title");
    // The closed button carries the speech bubble unless someone asks for the
    // logo instead.
    //
    // It used to take the avatar whenever one existed, which conflated two
    // decisions: the avatar is Jetta's face inside the conversation, and the
    // launcher is a button on someone else's page. A logo squeezed into a 56px
    // circle in the corner of a marketing site reads as an advert; the bubble
    // reads as "talk to us", which is the job. So `launcherIcon` chooses, and
    // the avatar keeps its real work in the panel header either way.
    if (brand.launcherIcon === "avatar" && brand.avatarUrl && /^data:image\//.test(brand.avatarUrl)) {
      icon.innerHTML = "";
      var img = document.createElement("img");
      img.src = brand.avatarUrl;
      img.alt = "";
      img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block";
      img.onerror = function () {
        icon.innerHTML = BUBBLE_SVG;
      };
      icon.appendChild(img);
    } else {
      icon.innerHTML = BUBBLE_SVG;
    }
    // Both the panel and the button move together, or the panel opens off the
    // side of the button that spawned it.
    //
    // The embedding page outranks the console here. The brand setting is one
    // value for every surface the brand is on, and the page is the only party
    // that knows this particular corner is already occupied.
    var left = SIDE ? SIDE === "left" : brand.launcherPosition === "left";
    root.style.right = left ? "auto" : EDGE_X + "px";
    root.style.left = left ? EDGE_X + "px" : "auto";
    launcher.style.float = left ? "left" : "right";
    launcherWrap.style.float = left ? "left" : "right";
    // The pill grows inward, away from the edge it is anchored to, so a long
    // label runs across the page rather than off the side of the viewport.
    launcher.style.flexDirection = left ? "row" : "row-reverse";
    label.style.padding = left ? "0 20px 0 4px" : "0 4px 0 20px";
    // The badge counts unread replies, so it belongs over the mark — which has
    // just swapped ends with the label.
    badge.style.right = left ? "auto" : "-2px";
    badge.style.left = left ? "-2px" : "auto";
    paintLabel();
  }

  /**
   * Show the label, or collapse back to the bare circle.
   *
   * Three things suppress it. There is nothing to say (no brand has been
   * reported yet, or this one set no label). The panel is already open, where
   * a button captioned "Chat with us" is arguing with a chat the visitor is
   * looking at. Or the viewport is narrow enough that a pill would span it —
   * on a phone the circle is the whole point, and a 260px button sitting over
   * the page the visitor came for is worse than no caption.
   */
  function paintLabel() {
    label.textContent = brand.launcherLabel || "";
    var show = !!brand.launcherLabel && !open && window.innerWidth >= 480;
    label.style.display = show ? "block" : "none";
  }
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
  paintLauncher();

  // The count belongs in the accessible name, because the badge itself is a
  // visual: a screen reader tabbing to the button should hear what the red
  // dot is telling everyone else.
  function paintAria() {
    launcher.setAttribute(
      "aria-label",
      open
        ? "Close support chat"
        : unread > 0
          ? "Open support chat, " + unread + " unread " + (unread === 1 ? "reply" : "replies")
          : "Open support chat",
    );
  }

  function renderBadge(animate) {
    var show = unread > 0 && !open;
    badge.style.display = show ? "block" : "none";
    badge.textContent = unread > 9 ? "9+" : String(unread);
    paintAria();
    if (show && animate) {
      // Clear, reflow, replay — the way to re-fire an animation that may
      // already have run. The nudge is on the wrap, not the launcher, whose
      // transform belongs to its hover scale.
      badge.style.animation = "none";
      launcherWrap.style.animation = "none";
      void badge.offsetWidth;
      badge.style.animation = "jettachat-pop .4s ease";
      launcherWrap.style.animation = "jettachat-nudge .5s ease";
    }
  }

  function setOpen(next) {
    open = next;
    paintAria();
    paintLabel();
    // Tell the frame. It holds the transcript and the read cursor, but it
    // renders whether or not anyone can see it — visibility is a fact only
    // this side of the iframe boundary knows.
    try {
      frame.contentWindow.postMessage({ type: "jettachat:visible", open: open }, origin || "*");
    } catch {
      // Frame not ready yet; the init handshake carries the state instead.
    }
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
    if (open) dismissed = true;
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
          open: open,
        },
        origin,
      );
    } else if (msg.type === "jettachat:brand") {
      brand = msg.brand || {};
      paintLauncher();
      try {
        localStorage.setItem(BRAND_KEY, JSON.stringify(brand));
      } catch {
        // A quota failure costs the next page load its instant branding and
        // nothing else — the frame re-sends this on every load.
      }
    } else if (msg.type === "jettachat:session") {
      writeSession(msg.session);
      // No session means no conversation — a badge counting replies in a
      // transcript that no longer exists would be advertising nothing.
      if (!msg.session && unread) {
        unread = 0;
        renderBadge();
      }
    } else if (msg.type === "jettachat:unread") {
      if (!open) {
        // A count is the frame's recount on page load — replies that arrived
        // while the visitor was on another page never fired a live event, so
        // the badge would otherwise reset to zero on every navigation. No
        // count is the live signal it has always been: one more.
        unread =
          typeof msg.count === "number" && isFinite(msg.count)
            ? Math.max(0, Math.floor(msg.count))
            : unread + 1;
        renderBadge(true);
      }
    } else if (msg.type === "jettachat:close") {
      dismissed = true;
      setOpen(false);
    } else if (msg.type === "jettachat:autoopen") {
      // The frame asked; the parent decides. Every one of these is a reason
      // not to interrupt someone.
      if (open) return; // already reading it
      if (dismissed) return; // they closed it — that was an answer
      if (autoOpenedRecently()) return; // not twice in a day
      // Not on phones. The panel is most of a small screen, so opening it
      // unasked hides the page the visitor came for.
      if (window.innerWidth < 640) return;
      rememberAutoOpen();
      setOpen(true);
    }
  });

  function mount() {
    document.body.appendChild(root);
    if (config.autoOpen) setOpen(true);
  }

  // Rotating a phone into landscape crosses the width threshold above, and a
  // label that only appears on reload is a label nobody trusts.
  window.addEventListener("resize", paintLabel);

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
