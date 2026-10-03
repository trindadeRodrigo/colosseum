import { useState } from 'react';
import { Button } from '../Button';

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
