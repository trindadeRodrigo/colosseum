// The mark, as drawn in guidelines.html: the 24px cut and the 16px cut. Provisional until the final
// artwork (DES-1 in the ledger). It takes the colour of the text around it.

export function Mark({ size }: { size: 16 | 24 }) {
  return size === 24 ? (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="1" y="7" width="3" height="10" />
      <rect x="5" y="1" width="8" height="22" />
      <path fillRule="evenodd" d="M14 9h9v6H14z M19 10.5a1.5 1.5 0 1 0 0.001 0z" />
    </svg>
  ) : (
    <svg width="1.15em" height="1.15em" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="1" y="1" width="4" height="14" />
      <path fillRule="evenodd" d="M6 4h9v8H6z M11 6a2 2 0 1 0 0.001 0z" />
    </svg>
  );
}
