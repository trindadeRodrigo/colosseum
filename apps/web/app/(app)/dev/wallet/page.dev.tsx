import { DevWallet } from '@/features/wallet/dev/DevWallet';

// `page.dev.tsx` is a route only under `next dev` (next.config.ts adds the extension in that phase and
// in no other), so a production build has no /dev/wallet and none of the code it imports.
export const metadata = { title: 'Wallet check (development)' };

export default function Page() {
  return <DevWallet />;
}
