# JettaChat — the manual pass

Three scripts cover the API surface (`chat-contract-test`, `chat-e2e`, `chat-eval`).
None of them can see the widget. This is the list of things that are only true in
a browser, and it is short on purpose — a checklist nobody finishes is a
checklist nobody runs.

Run it before a release that touches the widget, `public/jettachat.js`, or the
chat settings page. Ten minutes.

**Where to run it**

- `/chat-demo` — the internal demo page, for everything except the embed itself
- a real WordPress page with the install snippet, for the two embed checks
- a monday board with the app open, for the monday surface

---

## 1. The launcher

- [ ] The launcher appears bottom-right (or bottom-left if `launcherPosition` is
      set that way) and does not overlap the site's own controls — cookie
      banners and back-to-top buttons live in the same corner.
- [ ] Clicking it opens the panel; clicking it again closes it.
- [ ] With `autoOpenSeconds` set to 5, the panel opens itself once after five
      seconds — **and does not reopen** after you close it and navigate to
      another page. A chat window that keeps reopening is worse than one that
      never does.
- [ ] With `autoOpenSeconds` at 0 it never opens on its own.

## 2. Starting a chat

- [ ] The pre-chat form asks for name and email and will not submit without
      both. A junk address (`a@b`) is refused.
- [ ] The greeting from settings is what appears, not the built-in default.
- [ ] The accent colour from settings is applied to the header and the send
      button.
- [ ] Jetta's avatar renders if one is set, and the layout does not shift when
      there isn't one.

## 3. Sending a screenshot

The path most likely to break, and the one customers use most.

- [ ] **Paste** — take a screenshot and press ⌘V straight into the composer. It
      attaches. This is how most people do it and it is the easiest to break.
- [ ] Drag a PNG onto the panel — it attaches.
- [ ] Click the attach button and pick a PDF — it attaches.
- [ ] Send a screenshot with **no text at all**. It sends, and Jetta answers
      about what is in it.
- [ ] Attach a 30 MB file — refused, with a message saying why, before anything
      uploads.
- [ ] Rename a `.txt` to `.png` and attach it — refused.
- [ ] The thumbnail renders in the transcript, and clicking it opens the file.

## 4. Reload and resume

- [ ] Mid-conversation, reload the page. The transcript is still there.
- [ ] Navigate to a different page on the same site. Still there.
- [ ] Open the same site in a private window — a **new** conversation, with no
      trace of the first.
- [ ] Clear localStorage and reload. A new conversation starts cleanly rather
      than erroring.

## 5. The stream

- [ ] Jetta's typing indicator appears while she thinks and disappears when she
      answers. It never sticks.
- [ ] Leave the panel open and idle for **three minutes** — past the 120-second
      stream lifetime — then send a message. The reply still arrives. This is
      the reconnect, and a broken one looks exactly like a broken bot.
- [ ] Turn the network off, send a message, turn it back on. The widget
      recovers rather than sitting silent.

## 6. Human takeover, from both sides

Two windows: the widget, and `/chats` in the console.

- [ ] Ask the widget for a person. The conversation appears in the console
      inbox pinned to the top, and the nav badge counts it.
- [ ] Jetta stops talking the moment the handoff is requested.
- [ ] Press **Take this chat**. The visitor sees that a person joined.
- [ ] Type as the colleague — it arrives in the widget, attributed to the person
      and not to Jetta.
- [ ] Hand it back. Jetta picks up again on the next message.
- [ ] Leave a handoff unanswered past `handoffTimeoutMinutes`. The visitor gets
      the "nobody's free right now" message rather than silence, and Jetta
      resumes.

## 7. Convert to a ticket

- [ ] The convert button pre-fills the subject from the first thing the visitor
      **typed** — not from a screenshot's description.
- [ ] Converting posts a line in the chat telling the visitor.
- [ ] The ticket chip appears and opens Freshdesk in a new tab, at the right
      ticket.
- [ ] The button is gone once the conversation is ticketed.

## 8. Small screens

- [ ] On a phone, the panel fills the screen rather than floating in a corner.
- [ ] The composer is not hidden behind the on-screen keyboard.
- [ ] Long messages and code blocks scroll inside the panel — the page behind it
      never scrolls sideways.

## 9. The monday surface

- [ ] Opened inside a monday board, the widget knows the account without asking.
- [ ] The iframe renders — no `frame-ancestors` error in the console. This is
      the check that catches a CSP regression, and the console is the only place
      it shows.

## 10. The install snippet

- [ ] Copy the snippet from the console's install page onto a real WordPress
      page. The widget loads.
- [ ] Remove that site from the allowed origins and reload. The widget stays
      quiet — it does not render a launcher that fails when clicked.
- [ ] Switch the channel off in settings. The launcher disappears from the
      customer site without a deploy.

---

**If something here fails**, check whether it should have been caught by a
script first. Most of these are genuinely browser-only; a few (origins, limits,
takeover state) have script coverage, and a failure there means the script has a
gap worth closing.
