import { Showcase } from './Showcase';

// `page.dev.tsx` is a route only under `next dev` (next.config.ts adds the extension in that phase and
// in no other), so a production build has no /dev/ui and none of the sample content it imports.
export const metadata = { title: 'Design system (development)' };

export default function Page() {
  return <Showcase />;
}
