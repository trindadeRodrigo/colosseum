'use client';
import { AccountProvider } from '../account/AccountProvider';
import { SignInDialogBody } from '../account/SignInDialog';
import { WalletProvider } from '../wallet/WalletProvider';

// What the landing loads on the first press of "Sign in" (LandingSignIn.tsx): the wallet and the
// account the product's document has (components/shell/AppDocument.tsx), around the same panel as the
// product's sign-in dialog. The wallet provider loads Privy itself only when the panel asks for it.

export default function LandingSignInPanel(props: {
  titleId: string;
  next: string | null;
  onClose: () => void;
}) {
  return (
    <WalletProvider>
      <AccountProvider>
        <SignInDialogBody {...props} />
      </AccountProvider>
    </WalletProvider>
  );
}
