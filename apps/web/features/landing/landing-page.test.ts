import { describe, expect, it, vi } from 'vitest';
import LandingPage from '../../app/(marketing)/page';
import { SIGNED_IN_COOKIE } from '../../i18n';

// `/`: his landing page, for a visitor and for a person signed in on this browser alike (the product
// sets the hint while someone is signed in, and clears it when they sign out): the hint only changes
// the bar's action.

const jar = vi.hoisted(() => ({ values: new Map<string, string>() }));
const sent = vi.hoisted(() => ({ to: vi.fn() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.values.has(name) ? { value: jar.values.get(name) } : undefined),
  }),
}));
vi.mock('next/navigation', () => ({ redirect: sent.to, useRouter: () => ({}) }));
vi.mock('../../i18n/server', () => ({
  readPreferences: async () => ({ lang: 'pt', theme: 'auto' }),
}));

describe('the landing page', () => {
  it('is the landing for a visitor, in the language of the view', async () => {
    jar.values.clear();
    sent.to.mockClear();
    const page = await LandingPage();
    expect(sent.to).not.toHaveBeenCalled();
    expect((page.props as { lang: string }).lang).toBe('pt');
    expect((page.props as { signedIn: boolean }).signedIn).toBe(false);
  });

  it('is the landing for a person signed in on this browser too, never a redirect', async () => {
    jar.values.set(SIGNED_IN_COOKIE, '1');
    sent.to.mockClear();
    const page = await LandingPage();
    expect(sent.to).not.toHaveBeenCalled();
    expect((page.props as { signedIn: boolean }).signedIn).toBe(true);
  });
});

describe('the landing’s ground', () => {
  it('is dark with no choice, and follows the system once “System” is chosen', async () => {
    const { landingTheme } = await import('./theme');
    const { THEME_COOKIE } = await import('../../i18n');
    jar.values.clear();
    expect(await landingTheme()).toBe('dark');
    jar.values.set(THEME_COOKIE, 'auto');
    expect(await landingTheme()).toBe('auto');
    jar.values.set(THEME_COOKIE, 'light');
    expect(await landingTheme()).toBe('light');
    jar.values.set(THEME_COOKIE, 'nonsense');
    expect(await landingTheme()).toBe('dark');
  });
});
