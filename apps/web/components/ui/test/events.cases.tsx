import { useState } from 'react';
import { Button } from '../Button';
import { Composer } from '../Composer';
import { ConstraintSheet } from '../ConstraintSheet';
import { SHEET_CAPITAL, sheetGroups } from '../fixtures/mock';
import { ProvenancePin, type ProvenancePinProps } from '../ProvenancePin';
import type { PinSource } from '../provenance';

// What the event tests mount. Like cases.tsx, the JSX lives here because test files are plain .ts.

type Fn = () => void;

export const buttonInForm = (
  state: { busy?: boolean; disabled?: boolean },
  on: { submit: Fn; click: Fn; disabledClick?: Fn },
) => (
  <form
    onSubmit={(event) => {
      event.preventDefault();
      on.submit();
    }}
  >
    <input name="amount" defaultValue="5" />
    <Button
      type="submit"
      variant="primary"
      busyLabel="Signing…"
      onClick={on.click}
      onDisabledClick={on.disabledClick}
      {...state}
    >
      Sign: swap 5 USDC → USDY
    </Button>
  </form>
);

/** A form whose button goes busy on the first submit and stays busy: a signature in flight. */
export function SigningForm({ onSign }: { onSign: Fn }) {
  const [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        onSign();
      }}
    >
      <input name="amount" defaultValue="5" />
      <Button type="submit" variant="primary" busy={busy} busyLabel="Signing…">
        Sign: swap 5 USDC → USDY
      </Button>
    </form>
  );
}
export const signingForm = (onSign: Fn) => <SigningForm onSign={onSign} />;

export const linkButton = (
  state: { busy?: boolean; disabled?: boolean },
  on: { click: Fn; disabledClick?: Fn },
) => (
  <Button href="#sheet" onClick={on.click} onDisabledClick={on.disabledClick} {...state}>
    Edit sheet
  </Button>
);

// The constraint sheet. `PARSED` stands for what the validator returns once the sheet is valid.

export type ParsedSheet = { readonly parsed: true };
export const PARSED: ParsedSheet = { parsed: true };

type SheetCase = {
  /** Fields that do not fit, each with its sentence. */
  wrong?: boolean;
  valid: ParsedSheet | null;
  state?: 'idle' | 'solving' | 'no-plan';
  otherIssues?: readonly string[];
};

export const sheetToBuild = (
  { wrong = false, valid, state, otherIssues }: SheetCase,
  onBuild: (sheet: ParsedSheet) => void,
) => (
  <ConstraintSheet<ParsedSheet>
    groups={sheetGroups(wrong)}
    capital={SHEET_CAPITAL}
    valid={valid}
    state={state}
    otherIssues={otherIssues}
    onChange={() => {}}
    onBuild={onBuild}
  />
);

// The composer.

type Sent = (text: string) => void;

export const composerToSend = (
  props: { defaultValue?: string; busy?: boolean; disabled?: boolean },
  onSubmit: Sent,
) => <Composer label="Your goal" onSubmit={onSubmit} {...props} />;

export const subscribeField = (
  props: { defaultValue?: string; busy?: boolean },
  onSubmit: Sent,
) => (
  <Composer
    variant="single"
    label="Email address"
    inputType="email"
    sendText="Subscribe"
    busySendText="Subscribing…"
    onSubmit={onSubmit}
    {...props}
  />
);

// The pin, with something else on the page to press and to focus.

export const pinOnPage = (obs: PinSource | null, props: Partial<ProvenancePinProps> = {}) => (
  <div>
    <p>
      <ProvenancePin value="6.40%" obs={obs} {...props} />
    </p>
    <button type="button" id="elsewhere">
      elsewhere
    </button>
  </div>
);
