import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';
import { dictionary } from '../i18n';
import { BLACK } from '../lib/brand-grounds';

// The link preview (1200 × 630): the primary lockup (logo-directions.md: the mark, then the wordmark
// in Newsreader Medium, the gap the post's width) and the landing's headline, washi and hinoki on
// `black`. Words only: no figure, so nothing here could be taken for a result. Newsreader is
// committed beside it (assets/og, OFL), since the image is drawn at build with no network.

const t = dictionary('en');
export const alt = `tenonfi: ${t.landing.title}`;
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const WASHI = '#ECE4D6';
const HINOKI = '#E6D3B7';
const STONE = '#A49A8E';

export default async function Image() {
  const font = (file: string) => readFile(join(process.cwd(), 'assets/og', file));
  const [medium, regular] = await Promise.all([
    font('newsreader-72-500.woff'),
    font('newsreader-400.woff'),
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
        background: BLACK,
        color: WASHI,
        fontFamily: 'Newsreader',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        {/* the master cut, 2 px to the unit (Mark.tsx, logo-directions.md) */}
        <svg width="64" height="64" viewBox="0 0 32 32" fill={HINOKI} aria-hidden="true">
          <rect x="1" y="10" width="5" height="12" />
          <rect x="7" y="2" width="10" height="28" />
          <path fillRule="evenodd" d="M18 12h12v8H18z M25 14a2 2 0 1 0 0.001 0z" />
        </svg>
        <div style={{ fontSize: 72, fontWeight: 500, letterSpacing: '-0.015em', lineHeight: 1 }}>
          tenonfi
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
        <div
          style={{
            maxWidth: 960,
            fontSize: 60,
            fontWeight: 400,
            lineHeight: 1.12,
            letterSpacing: '-0.015em',
          }}
        >
          {t.landing.stage.title}
        </div>
        <div style={{ fontSize: 30, fontWeight: 400, color: STONE }}>
          {t.landing.stage.taglineStrong}
        </div>
      </div>
    </div>,
    {
      ...size,
      fonts: [
        { name: 'Newsreader', data: medium, weight: 500, style: 'normal' },
        { name: 'Newsreader', data: regular, weight: 400, style: 'normal' },
      ],
    },
  );
}
