// The grounds of color-system.md (IDENTITY-2), for what a browser draws around the page before any
// CSS: the address bar (`themeColor`), the manifest, the link preview. The page itself takes them from
// globals.css.

/** Day: warm paper. */
export const PAPER = '#F7F5F0';
/** Night: the cool near-black. */
export const NIGHT = '#0C0D12';
/** The old name of the night ground, kept for the files that still import it. */
export const BLACK = NIGHT;

/** The product's bar colour: paper in a light browser, night in a dark one. */
export const productThemeColor = [
  { media: '(prefers-color-scheme: light)', color: PAPER },
  { media: '(prefers-color-scheme: dark)', color: NIGHT },
];
