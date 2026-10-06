import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { Landing } from '../../features/landing/Landing';
import { landingTheme } from '../../features/landing/theme';
import { SIGNED_IN_COOKIE } from '../../i18n';
import { readPreferences } from '../../i18n/server';

// `/`: his landing page for a visitor. A person signed in on this browser goes straight to their goal,
// as his flow has it (compact-nav.md: once connected, the way in is the app). The hint is a cookie the
// product sets while someone is signed in and clears when they sign out; it proves nothing, it only
// says where to go.

export default async function LandingPage() {
  const jar = await cookies();
  if (jar.get(SIGNED_IN_COOKIE)?.value) redirect('/goal');
  const { lang } = await readPreferences();
  return <Landing lang={lang} theme={await landingTheme()} />;
}
