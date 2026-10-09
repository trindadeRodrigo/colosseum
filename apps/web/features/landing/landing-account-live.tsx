'use client';
import { createPortal } from 'react-dom';
import { AccountControl } from '../account/AccountControl';
import { AccountProvider } from '../account/AccountProvider';
import { SignInDialogBody } from '../account/SignInDialog';
import { WalletProvider } from '../wallet/WalletProvider';

// What the landing loads for the account (LandingAccount.tsx), on the first press of "Sign in" or
// at once for a person signed in on this browser: the wallet and the account the product's document
// has (components/shell/AppDocument.tsx), around the same control as the product's bar and the same
// panel as its sign-in dialog. One wallet for both, so a sign-in in the dialog is the bar's at once,
// with no reload. The wallet provider loads Privy itself only when something asks for the wallet.

export type LandingAccountLiveProps = {
  /** The signed-in hint, as the server read it. */
  hinted: boolean;
  /** Where the open dialog's panel goes: inside the frame the landing drew at the press. */
  panel: HTMLElement | null;
  next: string | null;
  titleId: string | null;
  onClose: () => void;
};

export default function LandingAccountLive({
  hinted,
  panel,
  next,
  titleId,
  onClose,
}: LandingAccountLiveProps) {
  return (
    <WalletProvider>
      <AccountProvider hinted={hinted}>
        {/* Outlined: the landing's filled action is the hero's "Start a plan". */}
        <AccountControl quiet />
        {panel &&
          titleId &&
          createPortal(<SignInDialogBody titleId={titleId} next={next} onClose={onClose} />, panel)}
      </AccountProvider>
    </WalletProvider>
  );
}
