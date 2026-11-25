/**
 * How often the chat looks for something new. Pure, shared by the server's
 * live stream and the widget's background check.
 *
 * Why this exists: in November 2026 about 14 live streams were open at any
 * moment, each reading Redis twice every 1.5 seconds, mostly for chats nobody
 * was looking at: the widget held a stream for as long as the visitor's page
 * was open, panel closed or tab in the background. That was most of Jetta's
 * hosting bill. Two rules replace it:
 *
 *  - The live stream is for eyes. The widget holds it only while the chat is
 *    on screen (`chatInView`), and the stream slows down when nothing is
 *    happening (`streamPollMs`).
 *  - Out of view, the widget asks once in a while (`backgroundCheckMs`), often
 *    enough for the unread badge and no more.
 */

/** The stream's pace while a reply is being written or messages are flowing. */
export const STREAM_ACTIVE_MS = 1500;
/** The stream's pace in a quiet conversation. */
export const STREAM_IDLE_MS = 3000;
/** A conversation counts as active this long after its latest message. */
export const STREAM_ACTIVE_WINDOW_MS = 30_000;

/** Out of view, while the visitor is waiting on an answer to what they just sent. */
export const BACKGROUND_WAITING_MS = 10_000;
/** Out of view, with nothing owed to the visitor. */
export const BACKGROUND_QUIET_MS = 30_000;
/** How long after their own message a visitor counts as waiting. */
export const WAITING_WINDOW_MS = 5 * 60_000;

/** Milliseconds until the stream's next look. */
export function streamPollMs(s: { typing: boolean; msSinceLastMessage: number | null }): number {
  if (s.typing) return STREAM_ACTIVE_MS;
  if (s.msSinceLastMessage !== null && s.msSinceLastMessage < STREAM_ACTIVE_WINDOW_MS) return STREAM_ACTIVE_MS;
  return STREAM_IDLE_MS;
}

/**
 * Can the visitor see the chat right now? The panel must be open (the parent
 * page reports that) and the tab must be the one in front.
 */
export function chatInView(s: { panelOpen: boolean; tabVisible: boolean }): boolean {
  return s.panelOpen && s.tabVisible;
}

/** Milliseconds until the widget's next background check. */
export function backgroundCheckMs(s: { lastAuthor: string | undefined; msSinceLastMessage: number | null }): number {
  const waiting = s.lastAuthor === "visitor" && s.msSinceLastMessage !== null && s.msSinceLastMessage < WAITING_WINDOW_MS;
  return waiting ? BACKGROUND_WAITING_MS : BACKGROUND_QUIET_MS;
}
