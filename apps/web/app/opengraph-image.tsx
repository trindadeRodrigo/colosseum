import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';
import { dictionary } from '../i18n';
import { NIGHT } from '../lib/brand-grounds';

// The link preview (1200 × 630): the primary lockup (logo-directions.md: the face, then the wordmark
// in Inter Tight 600 at −2%) and the landing's headline in Inter Tight 600, its line in Inter 400, in
// text and muted on night (IDENTITY-2, LOGO-2). Words only: no figure, so nothing here could be taken
// for a result. The two faces are committed beside it (assets/og, OFL), since the image is drawn at
// build with no network.

const t = dictionary('en');
export const alt = `tenonfi: ${t.landing.title}`;
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const TEXT = '#F3F1EC';
const MUTED = '#9A9DAD';
const HONEY = '#F5A83A';

export default async function Image() {
  const font = (file: string) => readFile(join(process.cwd(), 'assets/og', file));
  const [display, regular] = await Promise.all([
    font('inter-tight-600.woff'),
    font('inter-400.woff'),
  ]);
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: 80,
        background: NIGHT,
        color: TEXT,
        fontFamily: 'Inter Tight',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        {/* the master cut on night, 2 px to the unit (logo-directions.md, mark-32-night.svg) */}
        <svg width="64" height="64" viewBox="0 0 32 32" aria-hidden="true">
          <rect width="32" height="32" rx="7" fill={HONEY} />
          <rect x="7" y="10" width="18" height="12" rx="2" fill={NIGHT} />
          <rect x="18" y="13.5" width="5" height="5" rx="1" fill={HONEY} />
        </svg>
        <div style={{ fontSize: 72, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1 }}>
          tenonfi
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
        <div
          style={{
            maxWidth: 960,
            fontSize: 60,
            fontWeight: 600,
            lineHeight: 1.1,
            letterSpacing: '-0.02em',
          }}
        >
          {t.landing.hero.title}
        </div>
        <div style={{ fontSize: 30, fontWeight: 400, color: MUTED, fontFamily: 'Inter' }}>
          {t.landing.hero.lead}
        </div>
      </div>
    </div>,
    {
      ...size,
      fonts: [
        { name: 'Inter Tight', data: display, weight: 600, style: 'normal' },
        { name: 'Inter', data: regular, weight: 400, style: 'normal' },
      ],
    },
  );
}
