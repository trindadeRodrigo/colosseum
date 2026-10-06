// The grounds of color-system.md, for what a browser draws around the page before any CSS: the
// address bar (`themeColor`), the manifest, the link preview. The page itself takes them from
// globals.css.

export const PAPER = '#F6F1E8';
export const BLACK = '#0D0B09';

/** The product's bar colour: paper in a light browser, black in a dark one. */
export const productThemeColor = [
  { media: '(prefers-color-scheme: light)', color: PAPER },
  { media: '(prefers-color-scheme: dark)', color: BLACK },
];
