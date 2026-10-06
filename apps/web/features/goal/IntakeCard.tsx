'use client';
import type { Obligation, SharedFamily } from '@colosseum/schemas';
import Link from 'next/link';
import { type FormEvent, useId, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { Field, Input, Select } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { StatusMark } from '../../components/ui/StatusMark';
import type { Dictionary } from '../../i18n';
import { useT } from '../../i18n/I18nProvider';
import type { IntakeAnswers, IntakeQuestion, IntakeReading } from './intake';

// The guided intake on the goal screen (gate GUIDED-INTAKE; constraint-sheet.md, composer.md): what
// the person wrote, how it was read and by what, then either the questions still open, each with its
// control and started from what was read, or, once none is, what was understood, said back sentence
// by sentence by the server's templates, and "Build my plan". Withdrawals are given in the form, as
// answers. Nothing here reads the goal or makes the sheet: the answers go back to the intake, and the
// confirm sends the server's sheet as it came.

type Words = Dictionary['goal']['intake'];
type Form = {
  values: Partial<Record<IntakeQuestion['field'], string>>;
  themes: string[];
  noDate: boolean;
  withdrawals: { month: string; amount: string; currency: string }[];
};

const SIGN_IN = '/sign-in?next=/goal';

/** The form's first state: what was read, then what the person answered before. */
function formOf(reading: IntakeReading, answers: IntakeAnswers): Form {
  const values: Form['values'] = {};
  for (const q of reading.questions)
    if (typeof q.read === 'string' || typeof q.read === 'number') values[q.field] = String(q.read);
  const themesRead = reading.questions.find((q) => q.field === 'themes')?.read;
  const owed = answers.obligations ?? reading.sheet?.obligations ?? [];
  return {
    values,
    themes: answers.themes ?? (Array.isArray(themesRead) ? themesRead : []),
    noDate: answers.horizonOpen ?? false,
    withdrawals: owed.map((o) => ({
      month: o.month,
      amount: String(o.amount),
      currency: o.currency,
    })),
  };
}

const number = (v: string | undefined) => {
  const n = Number((v ?? '').replace(/[\s,$]/g, ''));
  return (v ?? '').trim() !== '' && Number.isFinite(n) ? n : null;
};

/** The answers a form gives, or the sentence for each field that does not fit. */
export function answersOf(
  form: Form,
  questions: IntakeQuestion[],
  words: Words,
): { answers: IntakeAnswers; errors: Record<string, string> } {
  const answers: IntakeAnswers = {};
  const errors: Record<string, string> = {};
  const e = words.errors;
  for (const q of questions) {
    const v = form.values[q.field];
    if (q.field === 'goal' || q.field === 'risk') {
      if (!v || !q.options?.includes(v)) errors[q.field] = e.choose;
      else if (q.field === 'goal') answers.goal = v as IntakeAnswers['goal'];
      else answers.risk = v as IntakeAnswers['risk'];
    } else if (q.field === 'amountUsd') {
      const n = number(v);
      if (n === null || n < 10 || n > 1_000_000) errors[q.field] = e.amount;
      else answers.amountUsd = n;
    } else if (q.field === 'incomeTargetUsdMonthly') {
      const n = number(v);
      if (n === null || n <= 0) errors[q.field] = e.income;
      else answers.incomeTargetUsdMonthly = n;
    } else if (q.field === 'horizonMonths') {
      if (form.noDate) answers.horizonOpen = true;
      else {
        const n = number(v);
        if (n === null || !Number.isInteger(n) || n < 1 || n > 480) errors[q.field] = e.horizon;
        else {
          answers.horizonMonths = n;
          answers.horizonOpen = false;
        }
      }
    } else if (q.field === 'currency') {
      const c = (v ?? '').trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(c)) errors[q.field] = e.currency;
      else answers.currency = c;
    } else if (q.field === 'themes') answers.themes = form.themes.slice(0, 3);
    // `sleeves` and `chains` are answered in words, and by choosing the chain, not here.
  }
  const owed: Obligation[] = [];
  for (const w of form.withdrawals) {
    const amount = number(w.amount);
    const currency = w.currency.trim().toUpperCase();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(w.month) || amount === null || amount <= 0)
      errors.withdrawals = e.withdrawal;
    else if (!/^[A-Z]{3}$/.test(currency)) errors.withdrawals = e.currency;
    else owed.push({ month: w.month, amount, currency });
  }
  if (!errors.withdrawals) answers.obligations = owed;
  return { answers, errors };
}

export function IntakeCard({
  id,
  goalText,
  followUps,
  reading,
  answers,
  shelf,
  sending,
  building,
  blocked,
  onAnswer,
  onConfirm,
}: {
  id: string;
  goalText: string;
  followUps: string[];
  reading: IntakeReading;
  /** What the person answered so far: the form starts from it. */
  answers: IntakeAnswers;
  /** The shared portfolios on the person's chain, for a question about themes. */
  shelf: SharedFamily[];
  sending: boolean;
  building: boolean;
  /** What stands between the confirmed sheet and a plan: who is asking, and on which chain. */
  blocked: string[];
  onAnswer: (answers: IntakeAnswers) => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const words = t.goal.intake;
  const titleId = useId();
  const formId = useId();
  const blockedId = useId();
  const [form, setForm] = useState<Form>(() => formOf(reading, answers));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const setValue = (field: IntakeQuestion['field'], value: string) =>
    set({ values: { ...form.values, [field]: value } });
  const { questions, readBack, reader } = reading;
  const open = questions.length > 0;

  function submit(e: FormEvent) {
    e.preventDefault();
    const read = answersOf(form, questions, words);
    setErrors(read.errors);
    if (Object.keys(read.errors).length > 0) return;
    onAnswer({ ...answers, ...read.answers });
  }

  const control = (q: IntakeQuestion) => {
    const err = errors[q.field];
    const fieldId = `${formId}-${q.field}`;
    if (q.field === 'sleeves' || q.field === 'chains')
      return (
        <div key={q.field} data-field={q.field} className="flex flex-col gap-1">
          <p className="text-body">{q.text}</p>
          {q.field === 'chains' ? (
            <Link href={SIGN_IN} className={buttonClass({ variant: 'link' })}>
              {t.goal.chain.choose}
            </Link>
          ) : (
            <p className="text-body-sm text-muted-foreground">{words.questions.inWords}</p>
          )}
        </div>
      );
    if (q.field === 'goal' || q.field === 'risk') {
      const names: Record<string, string> =
        q.field === 'goal' ? t.goal.options.goal : t.goal.options.risk;
      return (
        <Field key={q.field} label={q.text} error={err} id={fieldId} className="w-full">
          {(c) => (
            <Select
              {...c}
              data-field={q.field}
              value={form.values[q.field] ?? ''}
              onChange={(e) => setValue(q.field, e.target.value)}
            >
              <option value="">{t.goal.options.choose}</option>
              {(q.options ?? []).map((o) => (
                <option key={o} value={o}>
                  {names[o] ?? o}
                </option>
              ))}
            </Select>
          )}
        </Field>
      );
    }
    if (q.field === 'themes')
      return (
        <fieldset key={q.field} data-field={q.field} className="flex flex-col gap-2">
          <legend className="mb-1 text-caption font-medium">{q.text}</legend>
          {shelf.length === 0 ? (
            <p className="text-body-sm text-muted-foreground">{words.questions.none}</p>
          ) : (
            shelf.map((f) => (
              <label key={f.slug} className="inline-flex min-h-6 items-center gap-2 text-body">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={form.themes.includes(f.slug)}
                  disabled={!form.themes.includes(f.slug) && form.themes.length >= 3}
                  onChange={(e) =>
                    set({
                      themes: e.target.checked
                        ? [...form.themes, f.slug]
                        : form.themes.filter((s) => s !== f.slug),
                    })
                  }
                />
                {f.name}
              </label>
            ))
          )}
        </fieldset>
      );
    return (
      <div key={q.field} className="flex flex-col gap-2">
        <Field
          label={q.text}
          error={err}
          id={fieldId}
          hint={q.field === 'currency' ? words.questions.currencyHint : undefined}
        >
          {(c) => (
            <Input
              {...c}
              data-field={q.field}
              inputMode={q.field === 'currency' ? 'text' : 'decimal'}
              width={q.field === 'currency' ? '6ch' : '14ch'}
              maxLength={q.field === 'currency' ? 3 : 12}
              disabled={q.field === 'horizonMonths' && form.noDate}
              value={form.values[q.field] ?? ''}
              onChange={(e) => setValue(q.field, e.target.value)}
            />
          )}
        </Field>
        {q.field === 'horizonMonths' && (
          <label className="inline-flex min-h-6 items-center gap-2 text-body">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={form.noDate}
              onChange={(e) => set({ noDate: e.target.checked })}
            />
            {words.questions.noDate}
          </label>
        )}
      </div>
    );
  };

  const w = words.withdrawals;
  return (
    <div id={id} data-ui="intake" className="scroll-mt-6">
      <Card as="section" aria-labelledby={titleId}>
        <CardHeader title={words.title} level={2} id={titleId} />
        <CardBody className="clear-both flex flex-col gap-6">
          <p data-ui="intake-source" className="font-mono text-source text-muted-foreground">
            {reader.method === 'model' && reader.model
              ? words.readBy.model(reader.model)
              : words.readBy.rules}
            {/* a reply made up for a test says so once, quietly, beside what read it: no plate */}
            {reader.provenance === 'mock' && ` · ${words.sampleReply}`}
          </p>
          <div className="flex flex-col gap-1">
            <h3 className="text-caption text-muted-foreground">{words.said}</h3>
            <blockquote className="flex flex-col gap-1 text-body text-muted-foreground">
              {[goalText, ...followUps].map((said, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the same words may be said twice
                <p key={i}>“{said}”</p>
              ))}
            </blockquote>
          </div>

          <form id={formId} onSubmit={submit} noValidate className="flex flex-col gap-6">
            {open && (
              <section aria-labelledby={`${formId}-q`} className="flex flex-col gap-4">
                <h3 id={`${formId}-q`} className="text-[0.8125rem]/5 font-medium">
                  {words.questions.title}
                </h3>
                <p className="text-body-sm text-muted-foreground">
                  {questions.length === 1
                    ? words.questions.one
                    : words.questions.other(questions.length)}
                </p>
                {questions.map(control)}
              </section>
            )}
            <fieldset data-field="obligations" className="flex flex-col gap-3">
              <legend className="mb-1 text-caption font-medium">{w.legend}</legend>
              <p className="text-body-sm text-muted-foreground">{w.hint}</p>
              {form.withdrawals.length === 0 && (
                <p className="text-body-sm text-muted-foreground">{w.none}</p>
              )}
              {form.withdrawals.map((row, i) => {
                const at = (patch: Partial<Form['withdrawals'][number]>) =>
                  set({
                    withdrawals: form.withdrawals.map((r, j) => (j === i ? { ...r, ...patch } : r)),
                  });
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own
                  <div key={i} data-ui="withdrawal" className="flex flex-wrap items-end gap-3">
                    <Field label={w.month}>
                      {(c) => (
                        <Input
                          {...c}
                          type="month"
                          width="11ch"
                          value={row.month}
                          onChange={(e) => at({ month: e.target.value })}
                        />
                      )}
                    </Field>
                    <Field label={w.amount}>
                      {(c) => (
                        <Input
                          {...c}
                          inputMode="decimal"
                          width="12ch"
                          value={row.amount}
                          onChange={(e) => at({ amount: e.target.value })}
                        />
                      )}
                    </Field>
                    <Field label={w.currency}>
                      {(c) => (
                        <Input
                          {...c}
                          width="6ch"
                          maxLength={3}
                          value={row.currency}
                          onChange={(e) => at({ currency: e.target.value })}
                        />
                      )}
                    </Field>
                    <Button
                      variant="link"
                      onClick={() =>
                        set({ withdrawals: form.withdrawals.filter((_, j) => j !== i) })
                      }
                    >
                      <span className="sr-only">{w.remove(row.month || '…')}</span>
                      <Icon name="X" />
                    </Button>
                  </div>
                );
              })}
              <div>
                <Button
                  variant="secondary"
                  onClick={() =>
                    set({
                      withdrawals: [
                        ...form.withdrawals,
                        { month: '', amount: '', currency: reading.sheet?.currency ?? 'USD' },
                      ],
                    })
                  }
                >
                  {w.add}
                </Button>
              </div>
              {errors.withdrawals && (
                <p className="flex items-start gap-1.5 text-body-sm text-destructive">
                  <StatusMark status="off-track" size={12} className="mt-1.5" />
                  <span>{errors.withdrawals}</span>
                </p>
              )}
            </fieldset>
            <div>
              {/* One primary per view: the answers while anything is open, the confirm after. */}
              <Button
                type="submit"
                variant={open ? 'primary' : 'secondary'}
                busy={sending}
                busyLabel={words.questions.sending}
                disabled={building}
              >
                {open ? words.questions.reply : words.questions.update}
              </Button>
            </div>
          </form>

          {readBack && (
            <section
              aria-labelledby={`${formId}-rb`}
              data-ui="read-back"
              className="flex flex-col gap-3 border-t border-border pt-5"
            >
              <h3 id={`${formId}-rb`} className="text-[0.8125rem]/5 font-medium">
                {words.readBack.title}
              </h3>
              <ul className="flex max-w-(--tf-measure-body) flex-col gap-1.5 text-body">
                {readBack.map((sentence) => (
                  <li key={sentence}>{sentence}</li>
                ))}
              </ul>
              <div className="flex flex-col items-start gap-2">
                <Button
                  variant="primary"
                  busy={building}
                  busyLabel={words.readBack.building}
                  disabled={sending || blocked.length > 0}
                  aria-describedby={blocked.length > 0 ? blockedId : undefined}
                  onClick={onConfirm}
                >
                  {words.readBack.confirm}
                </Button>
                {blocked.length > 0 && (
                  <ul id={blockedId} className="flex flex-col gap-1 text-body-sm">
                    {blocked.map((why) => (
                      <li key={why}>{why}</li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
