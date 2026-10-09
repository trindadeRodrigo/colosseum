import { cookies } from 'next/headers';
import { Landing } from '../../features/landing/Landing';
import { platformStats } from '../../features/landing/stats';
import { SIGNED_IN_COOKIE } from '../../i18n';
import { readPreferences } from '../../i18n/server';

// `/`: his landing page, for everyone: the logo leads here from the app too (Thom, Oct 6). For a
// person signed in on this browser, the bar's action is the way back into the app in place of
// "Sign in". The hint is a cookie the product sets while someone is signed in and clears when they
// sign out; it proves nothing, it only says which action to show. The platform's numbers are read on
// the server, live when the API answers, sample otherwise (features/landing/stats.ts).

export default async function LandingPage() {
  const jar = await cookies();
  const signedIn = Boolean(jar.get(SIGNED_IN_COOKIE)?.value);
  const [{ lang }, stats] = await Promise.all([readPreferences(), platformStats()]);
  return <Landing lang={lang} stats={stats} signedIn={signedIn} />;
}
