'use client';
import { useId } from 'react';
import { Disclaimer } from '../../components/ui/Disclaimer';
import { type Execution, ExecutionList } from '../../components/ui/ExecutionList';
import { useLang, useT } from '../../i18n/I18nProvider';
import { utc } from '../portfolio/figures';

// His guide's "Disclaimer and activity" (guidelines.html, Components): the disclaimer from the one
// constant on the left, under its short heading, and what was done on the right, one line per step
// with its explorer link, under the order it was a step of. On a phone the two stack. The shell's foot
// does not repeat the disclaimer on a page that has this one (AppShell.tsx). The order's own page does
// not carry it: its steps are the same lines (the flow audit, finding 27).

/** One order's lines, under what the order was. */
export type ActivityGroup = { id: string; title: string; executions: readonly Execution[] };

export function ActivityPanel({
  groups,
  empty,
}: {
  groups: readonly ActivityGroup[];
  /** Said where there is nothing to list. */
  empty: string;
}) {
  const t = useT();
  const lang = useLang();
  const heading = useId();
  const words = t.activity;
  const shown = groups.filter((group) => group.executions.length > 0);
  return (
    <div data-ui="activity-panel" className="grid items-start gap-6 min-[980px]:grid-cols-2">
      <Disclaimer lang={lang} heading={words.notAdvice} label={t.shell.disclaimer} />
      <section aria-labelledby={heading} className="flex min-w-0 flex-col gap-2">
        <h2 id={heading} className="text-[0.8125rem]/5 font-medium">
          {words.title}
        </h2>
        {shown.length > 0 ? (
          shown.map((group) => (
            <div key={group.id} data-ui="activity-order" className="flex flex-col gap-1">
              <h3 className="text-caption text-muted-foreground">{group.title}</h3>
              <ExecutionList
                executions={group.executions}
                className="border-y border-border"
                formatTime={(at) => utc(lang, at)}
                labels={{
                  status: words.status,
                  unknownStatus: words.unknownStatus,
                  testNetwork: t.shell.testNetwork,
                  notRetried: words.notRetried,
                  signature: words.signature,
                  link: t.order.link,
                }}
              />
            </div>
          ))
        ) : (
          <p className="border-y border-border py-3 text-body-sm text-muted-foreground">{empty}</p>
        )}
      </section>
    </div>
  );
}
