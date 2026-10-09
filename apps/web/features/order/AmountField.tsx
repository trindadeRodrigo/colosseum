'use client';
import { cn } from '../../components/ui/cn';
import { Field, Input } from '../../components/ui/Field';
import { useT } from '../../i18n/I18nProvider';

// The amount of a buy, typed in dollars: the one field over the card on a buy screen, and, large, the
// one thing a person types on the deposit step of a new goal (features/mix/DepositStep.tsx). In a file
// of its own so the deposit step is not built with the invest card, which draws the order screen and so
// reaches the signing port.

export function AmountField({
  text,
  onText,
  hint,
  value,
  disabled = false,
  large = false,
  unit,
  error,
  onBlur,
}: {
  text: string;
  onText: (text: string) => void;
  hint: string;
  /** The amount in dollars, or null while the text is not one from $10 to $1,000,000. */
  value: number | null;
  /** The person pressed: the order under way is for the amount it was made for. */
  disabled?: boolean;
  /** The deposit step's field: the figure at heading size, with the dollar sign and the token beside it. */
  large?: boolean;
  /** The chain's dollar token, named after the figure of a large field: "USDC". */
  unit?: string;
  /** What to change, where the host knows more than "not an amount": below the least, above the most. */
  error?: string;
  onBlur?: () => void;
}) {
  const t = useT();
  // The large field's host says when an amount is wrong (after a pause, never on the first digit).
  const said =
    error ?? (!large && text.trim() && value === null ? t.buy.blocked.amount : undefined);
  return (
    <Field
      label={t.buy.amount.label}
      hint={hint}
      error={said}
      className={large ? 'w-full' : undefined}
    >
      {(control) =>
        large ? (
          <span
            data-ui="amount-large"
            className={cn(
              'flex h-14 w-full max-w-88 items-center gap-2 rounded-md border bg-muted px-3',
              'focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring',
              said ? 'border-destructive' : 'border-input',
            )}
          >
            <span aria-hidden="true" className="shrink-0 text-h4 text-muted-foreground">
              {t.mix.deposit.currency}
            </span>
            <input
              {...control}
              inputMode="decimal"
              autoComplete="off"
              placeholder="0"
              disabled={disabled}
              value={text}
              onChange={(e) => onText(e.currentTarget.value)}
              onBlur={onBlur}
              className="h-full min-w-0 flex-1 bg-transparent text-h3 text-foreground tabular-nums outline-none placeholder:text-muted-foreground"
            />
            {unit && <span className="shrink-0 text-body-sm text-muted-foreground">{unit}</span>}
          </span>
        ) : (
          <Input
            {...control}
            inputMode="decimal"
            width="14ch"
            disabled={disabled}
            value={text}
            onChange={(e) => onText(e.currentTarget.value)}
          />
        )
      }
    </Field>
  );
}
