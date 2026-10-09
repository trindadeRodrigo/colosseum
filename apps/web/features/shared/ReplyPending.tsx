'use client';
import { type RefObject, useEffect, useLayoutEffect, useState } from 'react';
import { Skeleton } from '../../components/ui/Skeleton';
import { WaitMark } from '../../components/ui/WaitMark';

// Waiting for a reply in a conversation (/goal and a vault's own), said where the reply will be: a row
// in the assistant's place under the person's message, with the loader and one plain line. A reply
// can take many seconds, so the line changes with time. It only ever says what the server does on
// every reply, in the order it does it, and never that a step is over: this page cannot know that.
// Nothing here is a figure, a share or a draft; those come from the server or not at all.

/** When the line under a sent message changes: after 4s, and after 15s. */
export const REPLY_LINE_MS = [4_000, 15_000] as const;

/** Which of the three lines a wait is on. It starts again with each wait. */
export function useReplyLine(busy: boolean): 0 | 1 | 2 {
  const [line, setLine] = useState<0 | 1 | 2>(0);
  useEffect(() => {
    setLine(0);
    if (!busy) return;
    const timers = [
      setTimeout(() => setLine(1), REPLY_LINE_MS[0]),
      setTimeout(() => setLine(2), REPLY_LINE_MS[1]),
    ];
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [busy]);
  return line;
}

/**
 * The reply that is on its way, as the last row of a transcript. The reply takes its place when it
 * comes, or the failure does. It is not a live region: the conversation announces the wait once
 * (`ReplyAnnouncer`), and a line that changes with time is not read out again.
 */
export function PendingReply({
  speaker,
  lines,
}: {
  /** Who is answering, for a reader who cannot see where the row sits. */
  speaker: string;
  /** What is said at once, after 4s and after 15s. */
  lines: readonly string[];
}) {
  const line = useReplyLine(true);
  return (
    <li
      data-ui="reply-pending"
      data-who="app"
      data-line={line}
      className="flex min-w-0 items-start gap-3 text-body text-muted-foreground"
    >
      <span className="sr-only">{speaker}: </span>
      <WaitMark size={24} />
      <span className="min-w-0 [overflow-wrap:anywhere]">{lines[line] ?? lines[0]}</span>
    </li>
  );
}

/**
 * The one polite announcement of a conversation: that a reply is being fetched, once, and then the
 * reply itself, once. The transcript and the preview card are not live regions, so nothing is said
 * twice.
 */
export function ReplyAnnouncer({ text }: { text: string }) {
  return (
    <p role="status" data-ui="reply-announcer" className="sr-only">
      {text}
    </p>
  );
}

/**
 * Keeps what was just sent in view. A transcript that is read back opens at its end. When a message
 * is sent, the row under it (the pending reply) is brought fully into view, in the transcript's own
 * scroll and in the page's, and then the box, which on a phone sits under the transcript and would
 * be pushed out by it. When the reply lands nothing is scrolled: it starts where the pending row was.
 * Focus is never moved.
 */
export function useChatScroll(
  list: RefObject<HTMLElement | null>,
  box: RefObject<HTMLElement | null>,
  busy: boolean,
  opened: string,
) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: `opened` names the transcript read back
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [opened]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the refs are read when a wait starts
  useLayoutEffect(() => {
    if (!busy) return;
    const row = list.current?.querySelector('[data-ui="reply-pending"]');
    row?.scrollIntoView?.({ block: 'nearest' });
    box.current?.querySelector('form')?.scrollIntoView?.({ block: 'nearest' });
  }, [busy]);
}

/**
 * The preview card while the first draft is worked on: the words at heading size, the loader, and
 * still boxes where the mix and its rows will be (Skeleton.tsx), so the card is already the size of a
 * small draft when one lands. The boxes are not figures and show none.
 */
export function DraftBuilding({
  title,
  line,
  note,
  rows = 3,
}: {
  title: string;
  line: string;
  /** The caption a draft carries: that it is a preview only. */
  note?: string;
  rows?: number;
}) {
  return (
    <div data-ui="draft-building" className="flex w-full min-w-0 flex-col gap-4">
      <div className="flex min-w-0 items-center gap-4">
        <WaitMark size={48} />
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="font-display font-semibold text-[1.25rem]/7">{title}</h2>
          <p className="max-w-[48ch] text-body-sm text-muted-foreground">{line}</p>
        </div>
      </div>
      <div aria-hidden="true" data-ui="draft-skeleton" className="flex min-w-0 flex-col gap-2">
        {/* the beam, then a row for each of a few holdings: swatch, mark, name, reason, share */}
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-3 w-48 max-w-full" />
        <div className="flex flex-col">
          {Array.from({ length: rows }, (_, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: still boxes with no identity of their own
              key={i}
              className="flex items-start gap-2 border-b border-border py-3"
            >
              <Skeleton className="mt-1.5 size-2.5 rounded-none" />
              <Skeleton className="size-6 rounded-full" />
              <span className="flex min-w-0 flex-1 flex-col gap-3 pt-1">
                <Skeleton className="h-3.5 w-24" />
                <Skeleton className="h-3 w-4/5" />
              </span>
              <Skeleton className="mt-1 h-3.5 w-10" />
            </div>
          ))}
        </div>
      </div>
      {note && <p className="text-caption text-muted-foreground">{note}</p>}
    </div>
  );
}
