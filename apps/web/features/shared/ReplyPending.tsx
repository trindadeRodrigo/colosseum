'use client';
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
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

/** How near its end a transcript must be for the person to count as following it, in px. */
const FOLLOWING = 48;

/**
 * Keeps what was just sent, and what answers it, in view. Focus is never moved.
 *
 * - A transcript that is read back opens at its end.
 * - When a message is sent, the row under it (the pending reply) is brought fully into view, in the
 *   transcript's own scroll and in the page's, and then the box, which on a phone sits under the
 *   transcript and would be pushed out by it.
 * - When the reply or the failure takes the pending row's place it is taller than the row was. If
 *   all of it fits, the transcript goes to its end, so a failure's "Try again" is in view; a reply
 *   too long for that starts at the top of the transcript, so it is read from its first line.
 * - A person who scrolled up meanwhile to read earlier turns is left where they are: nothing jumps,
 *   and the reply is at the end when they come back down.
 */
export function useChatScroll(
  list: RefObject<HTMLElement | null>,
  box: RefObject<HTMLElement | null>,
  busy: boolean,
  opened: string,
) {
  // where the pending row stood among the transcript's rows: what answers it takes that place
  const place = useRef<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `opened` names the transcript read back
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [opened]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the refs are read when a wait starts or ends
  useLayoutEffect(() => {
    const el = list.current;
    const form = box.current?.querySelector('form');
    if (busy) {
      const row = el?.querySelector('[data-ui="reply-pending"]');
      place.current = row && el ? [...el.children].indexOf(row) : null;
      row?.scrollIntoView?.({ block: 'nearest' });
      form?.scrollIntoView?.({ block: 'nearest' });
      // our own scroll is not the person's: they follow the transcript until they scroll away
      if (el) el.dataset.following = 'true';
      return;
    }
    const at = place.current;
    place.current = null;
    const landed = at === null ? null : (el?.children[at] as HTMLElement | undefined);
    if (!el || !landed || el.dataset.following !== 'true') return;
    if (el.scrollHeight - el.clientHeight > 1) {
      // the transcript scrolls on its own (a desk): its end, or the reply's first line at its top
      const top =
        landed.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      el.scrollTop = Math.min(top, el.scrollHeight - el.clientHeight);
    } else if (landed.dataset.ui?.endsWith('unanswered')) {
      // the page scrolls (a phone): a reply starts where the row was, which is in view; a failure
      // and its actions are brought in, and the box under them
      landed.scrollIntoView?.({ block: 'nearest' });
      form?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [busy]);
  // The person follows the transcript while its end is in view; scrolling up to read lets it go.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the transcript is mounted with its first turn
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const onScroll = () => {
      el.dataset.following = String(el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOWING);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [opened, busy]);
}

/**
 * The preview card while the first draft is worked on: the words at heading size, the loader, and
 * still boxes where the bar and its rows will be (Skeleton.tsx), so the card is already the size of a
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
