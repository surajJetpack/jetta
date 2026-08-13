import Script from "next/script";

export const dynamic = "force-dynamic";

/**
 * Widget demo — the embedded experience (launcher, panel, unread badge) as a
 * customer on the marketing site would see it, rather than the bare /chat UI.
 *
 * This page exists to exercise `public/jettachat.js` end-to-end against the
 * real deployment: same loader, same handshake, same session persistence. The
 * only difference from a real embed is that the host page happens to be served
 * from Jetta's own origin.
 */
export default function ChatDemoPage() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase">Internal demo</p>
      <h1 className="mt-2 text-2xl font-semibold">JettaChat widget</h1>
      <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-400">
        The launcher is in the bottom-right, exactly as it would appear on the marketing site.
        Open it and ask a real support question — Jetta answers from the live knowledge base.
      </p>

      <div className="mt-8 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
        <p className="font-medium">This talks to production.</p>
        <p className="mt-1">
          Replies come from the live KB and the transcript is stored for real. If you ask for a
          human, or for something the KB can&apos;t answer, Jetta will open a genuine Freshdesk
          ticket — so keep test conversations to product questions unless you want one.
        </p>
      </div>

      <p className="mt-8 text-sm text-neutral-600 dark:text-neutral-400">
        Things worth trying: a question the KB answers well (pricing, signed-document storage), a
        vague one (does it ask a clarifying question rather than guess?), and several short
        messages in a row (the debounce should answer the whole thought once, not three times).
      </p>

      <p className="mt-6 text-xs text-neutral-500">
        Transcripts and run traces land in <span className="font-mono">/chats</span>.
      </p>

      {/* Same loader a real embed uses — no special-casing for the demo. */}
      <Script src="/jettachat.js" strategy="afterInteractive" data-surface="wordpress" />
    </div>
  );
}
