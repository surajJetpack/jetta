"use client";

/**
 * The open conversation's controls: the actions that sit in its header (take
 * over, hand back, resolve or reopen, and the make-a-ticket dialog) and the
 * reply box at its foot. Presentational — the draft, the ticket fields and
 * every action live in ChatInbox and arrive as props.
 */
import { CheckCheck, Hand, RotateCcw, Send, Ticket as TicketIcon, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ConfirmButton } from "@/components/jetta/confirm-button";
import { suggestSubject, type Conv } from "./chat-types";

export type ChatAction = "join" | "send" | "release" | "resolve" | "reopen";

export function ConversationActions({
  detail,
  mine,
  busy,
  act,
  convert,
  ticketFieldId,
  ticketSubject,
  setTicketSubject,
  ticketNote,
  setTicketNote,
  ticketNotify,
  setTicketNotify,
  attachmentCount,
}: {
  detail: Conv;
  mine: boolean;
  busy: boolean;
  act: (action: ChatAction, body?: string) => Promise<void>;
  convert: () => Promise<void>;
  ticketFieldId: string;
  ticketSubject: string;
  setTicketSubject: (subject: string) => void;
  ticketNote: string;
  setTicketNote: (note: string) => void;
  ticketNotify: boolean;
  setTicketNotify: (notify: boolean) => void;
  attachmentCount: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {!mine ? (
        <Button size="sm" disabled={busy} onClick={() => void act("join")}>
          <Hand /> Take over
        </Button>
      ) : (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void act("release")}>
          <Undo2 /> Hand back to Jetta
        </Button>
      )}
      {/* No confirmation dialog, unlike "Make a ticket": nothing
          leaves the building, the visitor is told nothing, and the
          button that undoes it takes its place. Their next message
          reopens it anyway. */}
      {detail.status === "resolved" ? (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void act("reopen")}>
          <RotateCcw /> Reopen
        </Button>
      ) : (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void act("resolve")}>
          <CheckCheck /> Resolve
        </Button>
      )}
      {/* Hidden once ticketed. Jetta may open a second ticket for a
          genuinely separate issue, but this button cannot tell one
          issue from another — it would just re-file the same chat,
          which is the duplicate-thread failure. Raise the second one
          in Freshdesk, where you can see what the first says. */}
      {!detail.ticketId && (
        <ConfirmButton
          size="sm"
          variant="outline"
          busy={busy}
          disabled={!detail.visitor.email}
          title="Hand this to the support team"
          confirmLabel="Create the ticket"
          onConfirm={convert}
          description={
            <div className="space-y-3 text-left">
              <div className="space-y-1">
                <Label htmlFor={`${ticketFieldId}-subject`} className="text-xs text-foreground">
                  Subject
                </Label>
                <Input
                  id={`${ticketFieldId}-subject`}
                  value={ticketSubject || suggestSubject(detail)}
                  onChange={(e) => setTicketSubject(e.target.value)}
                  className="text-sm"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${ticketFieldId}-note`} className="text-xs text-foreground">
                  For whoever picks it up
                </Label>
                <Textarea
                  id={`${ticketFieldId}-note`}
                  rows={3}
                  value={ticketNote}
                  placeholder="What you already know, what you ruled out…"
                  onChange={(e) => setTicketNote(e.target.value)}
                  className="text-sm"
                />
              </div>
              <p className="text-2xs text-muted-foreground">
                Goes to <span className="text-foreground">{detail.visitor.email}</span>. The
                full transcript
                {attachmentCount > 0 &&
                  ` and ${attachmentCount} file${attachmentCount === 1 ? "" : "s"}`}{" "}
                {attachmentCount > 0 ? "go" : "goes"} with it.
              </p>
              <div className="flex items-start gap-2">
                <Checkbox
                  id={`${ticketFieldId}-notify`}
                  className="mt-0.5"
                  checked={ticketNotify}
                  onCheckedChange={(v) => setTicketNotify(!!v)}
                />
                <Label
                  htmlFor={`${ticketFieldId}-notify`}
                  className="block text-xs leading-normal font-normal"
                >
                  Tell the visitor in the chat
                  <span className="block text-2xs text-muted-foreground">
                    Jetta keeps chatting either way, but she won&apos;t announce a ticket
                    she didn&apos;t open — without this, nothing tells them their question
                    moved.
                  </span>
                </Label>
              </div>
            </div>
          }
        >
          <TicketIcon /> Make a ticket
        </ConfirmButton>
      )}
    </div>
  );
}

export function ChatComposer({
  detail,
  mine,
  text,
  setText,
  busy,
  act,
}: {
  detail: Conv;
  mine: boolean;
  text: string;
  setText: (text: string) => void;
  busy: boolean;
  act: (action: ChatAction, body?: string) => Promise<void>;
}) {
  const first = (detail.visitor.name || "").split(" ")[0] || "the visitor";
  return (
    <footer className="px-4 pt-2 pb-4 sm:px-5">
      <div className="rounded-xl border bg-card shadow-card focus-within:ring-[3px] focus-within:ring-ring/50">
        <Textarea
          rows={3}
          value={text}
          placeholder={
            mine
              ? `Reply to ${first}…`
              : `Reply to ${first}. Sending takes the chat over from Jetta.`
          }
          aria-label="Reply to the visitor"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && text.trim() && !busy) {
              e.preventDefault();
              void act("send", text.trim());
            }
          }}
          disabled={busy}
          className="min-h-0 resize-none border-0 bg-transparent px-3.5 pt-3 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        <div className="flex items-center gap-3 border-t px-3 py-2">
          <span className="text-2xs text-muted-foreground">
            {mine ? "Jetta is silent while you have this chat." : "Enter to send · Shift+Enter for a new line"}
          </span>
          <Button
            size="sm"
            className="ml-auto"
            disabled={busy || !text.trim()}
            onClick={() => void act("send", text.trim())}
          >
            Send <Send />
          </Button>
        </div>
      </div>
    </footer>
  );
}
