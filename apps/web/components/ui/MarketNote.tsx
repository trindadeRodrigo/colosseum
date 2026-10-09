// Beside a stock or fund price while its market is closed: the test networks hold the last price with
// a fresh timestamp over a weekend, so it would read as just updated. "Last price", not "last close":
// `closed` is the chain's session rule, which a pause inside the session also answers. The word is the server's
// (`Price.market`, read from the chain's own session rule): `closed` says it, `open` and `unknown` say
// nothing, and an asset that trades at all hours is answered `open`. Never worked out from this
// browser's clock. Text only: the pin and the test-network mark stay where they are.

export function MarketNote({
  market,
  label,
}: {
  market: 'open' | 'closed' | 'unknown' | undefined;
  label: string;
}) {
  if (market !== 'closed') return null;
  return (
    <span data-ui="market-closed" className="block text-caption text-muted-foreground">
      {label}
    </span>
  );
}
