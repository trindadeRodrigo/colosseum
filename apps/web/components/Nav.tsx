import Link from 'next/link';

// The bar of the one page still on the first shell (app/(structurer)/plans/[id]): the way back into
// the product, by the names its own bar uses. No wallet button: nothing on that page signs.
export function Nav() {
  return (
    <header className="flex items-center justify-between border-b border-gray-200 py-3">
      <nav aria-label="Main" className="flex gap-5 text-sm">
        <Link href="/" className="font-semibold">
          tenonfi
        </Link>
        <Link href="/shelf">Products</Link>
        <Link href="/goal">Invest</Link>
        <Link href="/analytics/stocks">Analytics</Link>
      </nav>
    </header>
  );
}
