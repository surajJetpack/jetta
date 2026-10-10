"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { EmptyState } from "@/components/jetta/empty-state";
import { appName } from "@/lib/types";
import { localZone, useHydrated } from "@/lib/format";
import { usePolling } from "@/lib/use-polling";
import { armChime, chimeEnabled, playChime, subscribeChime } from "@/components/jetta/chime";
import { ALL_APPS, NO_APP, appOf, type Conv, type Filter } from "./chat-types";
import { ChatList } from "./chat-list";
import { ConversationHeader, Transcript } from "./chat-transcript";
import { ChatComposer, type ChatAction } from "./chat-composer";

/**
 * The chat inbox.
 *
 * Two panes because live chat is not archive-reading: you watch a list for
 * someone who needs you, open them, and keep half an eye on everything else
 * while you type. Click-through-and-back loses that peripheral view, which is
 * the whole reason an inbox looks like an inbox.
 *
 * Selection lives in the URL (?c=…) so a conversation stays linkable — the
 * Slack handoff ping points at one, and it must survive a refresh.
 */
export default function ChatInbox({
  initial,
  avatars,
  freshdeskDomain,
}: {
  initial: Conv[];
  /** Jetta's configured widget avatar per brand — icon fallback when unset. */
  avatars: { main?: string; getsign?: string };
  freshdeskDomain: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const selectedId = params.get("c");

  const [list, setList] = useState<Conv[]>(initial);
  const [fetched, setFetched] = useState<Conv | null>(
    initial.find((c) => c.id === selectedId) ?? null,
  );
  // Derived rather than cleared in an effect: this both satisfies
  // react-hooks/set-state-in-effect and stops the PREVIOUS conversation
  // flashing up for a poll cycle after you click a different one.
  const detail = fetched && fetched.id === selectedId ? fetched : null;
  /*
   * Named next to the transcript because the transcript's times are local and
   * the SAME conversation's Freshdesk transcript is fixed to UTC. Without the
   * zone on screen, reconciling the two means guessing which one you are
   * holding — and the guess is silent when it is wrong.
   */
  const zone = localZone();
  /*
   * Everything below that reads a clock is gated on this.
   *
   * The transcript is server-rendered — `fetched` is seeded from `initial`, so
   * loading /chats?c=<id> directly paints the bubbles on the server, in the
   * SERVER's zone. Day dividers and run boundaries then come out differently
   * on a viewer in another zone, which is a structural mismatch rather than a
   * textual one: React throws and regenerates the pane. Observed as an avatar
   * on one side and a spacer on the other, either side of a midnight that only
   * exists in one of the two zones.
   */
  const hydrated = useHydrated();
  const attachmentCount = detail?.messages.reduce((n, m) => n + (m.attachments?.length ?? 0), 0) ?? 0;
  const [filter, setFilter] = useState<Filter>("all");
  const [app, setApp] = useState<string>(ALL_APPS);
  // Shared by the list and the counts above it: a "Needs a person · 1" badge
  // that counts a visitor the app filter is hiding sends you clicking after a
  // row that will not be there. The sidebar's own waiting badge stays global,
  // so nobody is lost by narrowing this view.
  const inApp = useCallback((c: Conv) => app === ALL_APPS || appOf(c) === app, [app]);
  const [query, setQuery] = useState("");
  const [text, setText] = useState("");
  const [ticketSubject, setTicketSubject] = useState("");
  const ticketFieldId = useId();
  const [ticketNote, setTicketNote] = useState("");
  const [ticketNotify, setTicketNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  // The setting lives in localStorage, which the server render can't see —
  // useSyncExternalStore renders the default and corrects itself without a
  // hydration mismatch, and follows the toggle across console tabs.
  const sound = useSyncExternalStore(subscribeChime, chimeEnabled, () => true);
  const endRef = useRef<HTMLDivElement | null>(null);
  const msgCount = useRef(0);

  /**
   * Every message id we have already laid eyes on — seeded from the server
   * render on first use, so nothing rings for history. Both polls feed it,
   * which is also what stops the fast detail poll and the slow list poll
   * ringing twice for the same message.
   */
  const seenIds = useRef<Set<string> | null>(null);

  useEffect(() => {
    armChime();
  }, []);

  /**
   * Ring for a visitor message a person is on the hook for.
   *
   * Only in conversations that are with (or waiting for) a human — Jetta
   * answers the rest herself, and a chime for traffic she is handling is an
   * alarm that cries wolf. And not for the conversation currently on screen in
   * a visible tab: a sound narrating what you are already reading teaches you
   * to turn the sound off.
   */
  const noteMessages = useCallback(
    (convs: Conv[]) => {
      const seen = (seenIds.current ??= new Set(
        initial.flatMap((c) => c.messages.map((m) => m.id)),
      ));
      let ring = false;
      for (const c of convs) {
        for (const m of c.messages) {
          if (seen.has(m.id)) continue;
          seen.add(m.id);
          if (m.author !== "visitor" || m.system) continue;
          if (c.status !== "human" && c.status !== "waiting_human") continue;
          if (c.id === selectedId && document.visibilityState === "visible") continue;
          ring = true;
        }
      }
      if (ring) playChime("message");
    },
    [initial, selectedId],
  );

  // The list refreshes slowly, the open conversation quickly — someone typing
  // a reply needs the visitor's next message now; the list can lag.
  const pollList = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/chats", { cache: "no-store" });
      if (!r.ok) return;
      const convs = ((await r.json()).conversations ?? []) as Conv[];
      setList(convs);
      noteMessages(convs);
    } catch {
      /* a dropped poll fixes itself on the next tick */
    }
  }, [noteMessages]);

  const pollDetail = useCallback(async () => {
    if (!selectedId) return;
    try {
      const r = await fetch(`/api/admin/chats?id=${encodeURIComponent(selectedId)}`, {
        cache: "no-store",
      });
      if (!r.ok) return;
      const conv = ((await r.json()).conversation ?? null) as Conv | null;
      setFetched(conv);
      if (conv) noteMessages([conv]);
    } catch {
      /* keep showing what we have */
    }
  }, [selectedId, noteMessages]);

  // usePolling rather than a hand-rolled interval: it is the console's existing
  // idiom, it pauses in a background tab, and its callback shape keeps every
  // setState inside a promise rather than an effect body.
  //
  // The list poll keeps running in a hidden tab — it is what carries the chime
  // for a visitor replying while you are off in Freshdesk, and ten seconds of
  // lag on the sound is fine where three would be waste. The detail poll stays
  // visibility-gated: at 3s it exists to feed eyes, and hidden tabs have none.
  usePolling(pollDetail, 3000);
  usePolling(pollList, 10_000, { whileHidden: true });

  // Only follow the conversation down when something new arrives, so reading
  // back through it isn't yanked to the bottom every three seconds.
  useEffect(() => {
    const n = detail?.messages.length ?? 0;
    if (n > msgCount.current) endRef.current?.scrollIntoView({ behavior: "smooth" });
    msgCount.current = n;
  }, [detail?.messages.length]);

  const select = (id: string | null) => {
    // Drop any half-written ticket, so a subject typed for one conversation
    // cannot be submitted against the next one.
    setTicketSubject("");
    setTicketNote("");
    const q = new URLSearchParams(Array.from(params.entries()));
    if (id) q.set("c", id);
    else q.delete("c");
    router.replace(`/chats${q.size ? `?${q}` : ""}`, { scroll: false });
  };

  const act = async (action: ChatAction, body?: string) => {
    if (!detail) return;
    setBusy(true);
    try {
      const res = await fetch("/api/admin/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: detail.id, action, text: body }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      if (action === "send") setText("");
      await Promise.all([pollDetail(), pollList()]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Hand the conversation to Freshdesk by hand.
   *
   * The same path Jetta uses, so the ticket carries the transcript, the
   * visitor's files and the link back either way. It exists because for the
   * whole life of the automated tool there was no way to work around it when
   * it broke — and it did break, silently, on every attempt.
   */
  const convert = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      const res = await fetch("/api/admin/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: detail.id,
          action: "ticket",
          subject: ticketSubject.trim(),
          text: ticketNote.trim(),
          notify: ticketNotify,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        ticketId?: string;
        alreadyTicketed?: boolean;
      };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      toast.success(
        data.alreadyTicketed
          ? `Already ticketed as #${data.ticketId}.`
          : `Ticket #${data.ticketId} created.`,
      );
      setTicketNote("");
      await Promise.all([pollDetail(), pollList()]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = (c: Conv) =>
      !q ||
      // `app` is in here so "getsign" narrows the list to GetSign's own widget
      // without a second row of filter buttons in a sidebar this narrow.
      [
        c.visitor.name,
        c.visitor.email,
        c.visitor.mondayAccountSlug,
        c.visitor.app,
        ...c.messages.map((m) => m.text),
      ]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    /*
     * "All live" excludes resolved, which is why it is not called "All".
     *
     * A finished conversation has to leave the working view or the list only
     * grows, and at ~10 chats a day a month of resolved chats would bury the
     * three that need someone. But a pill labelled "All" that hides rows is
     * the trap this file argues against elsewhere — so the label says what it
     * does, and the resolved ones get a bucket of their own next to it.
     */
    const inFilter = (c: Conv) =>
      filter === "all"
        ? c.status !== "resolved"
        : filter === "needs_human"
          ? c.status === "waiting_human" || c.status === "human"
          : filter === "open"
            ? c.status === "open"
            : filter === "resolved"
              ? c.status === "resolved"
              : c.status === "ticketed";

    // Anyone waiting for a person floats to the top whatever the sort — that is
    // the only row on this page with someone actually sitting there.
    //
    // Sessions with no messages are hidden rather than deleted: someone opened
    // the widget and left without typing, which is not a conversation but IS
    // worth counting, so the total is shown under the list.
    return list
      .filter((c) => c.messages.length > 0 && matches(c) && inFilter(c) && inApp(c))
      .sort(
        (a, b) =>
          Number(b.status === "waiting_human") - Number(a.status === "waiting_human") ||
          Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt),
      );
  }, [list, query, filter, inApp]);

  /*
   * One option per app that actually appears, commonest first, each with its
   * count — a fixed list of all nine apps would offer eight empty views on a
   * quiet week. Counted before the app filter is applied (so the numbers do
   * not collapse to the selection) but after the search and status filters, so
   * they describe the list you are looking at.
   */
  const appOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of list) {
      if (!c.messages.length) continue;
      counts.set(appOf(c), (counts.get(appOf(c)) ?? 0) + 1);
    }
    // The catch-all sits at the bottom whatever its count — it is where you
    // look when the named ones did not have it, not a peer of them.
    return [...counts.entries()]
      .sort(
        (a, b) =>
          Number(a[0] === NO_APP) - Number(b[0] === NO_APP) ||
          b[1] - a[1] ||
          a[0].localeCompare(b[0]),
      )
      .map(([value, count]) => ({
        value,
        count,
        // "Other apps", not the "Unattributed" the rest of the console uses: on
        // this page the bucket is a place to look, and everything in it IS one
        // of the apps — nobody has told us which. The reporting surfaces keep
        // the honest word, because there an unattributed row is a measurement
        // problem rather than a shelf.
        label: value === NO_APP ? "Other apps" : appName(value),
      }));
  }, [list]);

  const waiting = list.filter((c) => c.status === "waiting_human" && inApp(c)).length;
  // Counted the same way as `waiting`: after the app filter, so the number
  // describes the bucket you would land in rather than the whole store.
  const resolvedCount = list.filter(
    (c) => c.status === "resolved" && c.messages.length > 0 && inApp(c),
  ).length;
  const abandoned = list.filter((c) => c.messages.length === 0).length;
  const mine = detail?.status === "human";

  return (
    <div className="grid gap-5 md:grid-cols-[360px_1fr]">
      {/* ── list ─────────────────────────────────────────────── */}
      <ChatList
        detail={detail}
        query={query}
        setQuery={setQuery}
        appOptions={appOptions}
        app={app}
        setApp={setApp}
        filter={filter}
        setFilter={setFilter}
        waiting={waiting}
        resolvedCount={resolvedCount}
        sound={sound}
        visible={visible}
        select={select}
        abandoned={abandoned}
      />

      {/* ── conversation ─────────────────────────────────────── */}
      <section className="min-w-0">
        {!detail ? (
          <EmptyState
            title="Pick a conversation"
            hint="Anyone waiting for a person is pinned to the top of the list."
            className="min-h-96 justify-center rounded-xl border bg-card shadow-card"
          />
        ) : (
          <div className="flex h-[76dvh] flex-col rounded-lg border">
            <ConversationHeader
              detail={detail}
              hydrated={hydrated}
              zone={zone}
              freshdeskDomain={freshdeskDomain}
              select={select}
            />
            <Transcript detail={detail} hydrated={hydrated} zone={zone} avatars={avatars} endRef={endRef} />
            <ChatComposer
              detail={detail}
              mine={mine}
              text={text}
              setText={setText}
              busy={busy}
              act={act}
              convert={convert}
              ticketFieldId={ticketFieldId}
              ticketSubject={ticketSubject}
              setTicketSubject={setTicketSubject}
              ticketNote={ticketNote}
              setTicketNote={setTicketNote}
              ticketNotify={ticketNotify}
              setTicketNotify={setTicketNotify}
              attachmentCount={attachmentCount}
            />
          </div>
        )}
      </section>
    </div>
  );
}
