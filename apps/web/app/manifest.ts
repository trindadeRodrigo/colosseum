import type { MetadataRoute } from 'next';
import { dictionary } from '../i18n';
import { BLACK } from '../lib/brand-grounds';

// The web app manifest (`/manifest.webmanifest`): the name as the product writes it, the tile from
// scripts/make-icons.mjs, and the grounds of color-system.md (`black`, as the landing opens).

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'tenonfi',
    short_name: 'tenonfi',
    description: dictionary('en').landing.description,
    start_url: '/',
    display: 'standalone',
    background_color: BLACK,
    theme_color: BLACK,
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  };
}
