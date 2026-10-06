'use client';
import { useId } from 'react';
import { Disclaimer } from '../../components/ui/Disclaimer';
import { type Execution, ExecutionList } from '../../components/ui/ExecutionList';
import { useLang, useT } from '../../i18n/I18nProvider';

// His guide's "Disclaimer and activity" (guidelines.html, Components): the disclaimer from the one
// constant on the left, under its short heading, and what was done on the right, one line per step
// with its explorer link. On a phone the two stack. The shell's foot does not repeat the disclaimer
// on a page that has this one (AppShell.tsx).

export function ActivityPanel({
  executions,
  empty,
}: {
  executions: readonly Execution[];
  /** Said where there is nothing to list. */
  empty: string;
}) {
  const t = useT();
  const lang = useLang();
  const heading = useId();
  const words = t.activity;
  return (
    <div data-ui="activity-panel" className="grid items-start gap-6 min-[980px]:grid-cols-2">
      <Disclaimer lang={lang} heading={words.notAdvice} label={t.shell.disclaimer} />
      <section aria-labelledby={heading} className="flex min-w-0 flex-col gap-2">
        <h2 id={heading} className="text-[0.8125rem]/5 font-medium">
          {words.title}
        </h2>
        {executions.length > 0 ? (
          <ExecutionList
            executions={executions}
            className="border-y border-border"
            labels={{
              status: words.status,
              unknownStatus: words.unknownStatus,
              testNetwork: t.shell.testNetwork,
              notRetried: words.notRetried,
              signature: words.signature,
              link: t.order.link,
            }}
          />
        ) : (
          <p className="border-y border-border py-3 text-body-sm text-muted-foreground">{empty}</p>
        )}
      </section>
    </div>
  );
}
