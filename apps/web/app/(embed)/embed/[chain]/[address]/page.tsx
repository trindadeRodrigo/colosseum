import { ChainId } from '@colosseum/schemas';
import { notFound } from 'next/navigation';
import { EmbedVault } from '../../../../../features/embed/EmbedVault';
import { hatchTooFaint, partnerTheme, themeStyle } from '../../../../../features/embed/theme';

// A plan held in a vault, in the partner's skin: read-only, from the public vault route.

export default async function EmbedVaultPage({
  params,
  searchParams,
}: {
  params: Promise<{ chain: string; address: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { chain, address } = await params;
  const known = ChainId.safeParse(chain);
  if (!known.success) notFound();
  const theme = partnerTheme(await searchParams);
  return (
    <EmbedVault
      chain={known.data}
      address={decodeURIComponent(address)}
      style={themeStyle(theme)}
      suppressHatch={hatchTooFaint(theme)}
    />
  );
}
