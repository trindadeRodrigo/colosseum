import { ChainId } from '@colosseum/schemas';
import { familyBuyMetadata } from '../../../../../components/shell/metadata';
import { FamilyBuyScreen } from '../../../../../features/shared/FamilyBuyScreen';

// Buying a shared portfolio, which opens a vault that follows it. Nothing is signed here.

export function generateMetadata() {
  return familyBuyMetadata();
}

export default async function FamilyBuyPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ chain?: string | string[] }>;
}) {
  const { slug } = await params;
  // The recipe to buy, for a portfolio on more than one chain (`?chain=robinhood`).
  const named = ChainId.safeParse((await searchParams).chain);
  return <FamilyBuyScreen slug={slug} chain={named.success ? named.data : null} />;
}
