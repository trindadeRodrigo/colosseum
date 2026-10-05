import { describe, expect, it, vi } from 'vitest';
import LandingPage from '../../app/(marketing)/page';
import { SIGNED_IN_COOKIE } from '../../i18n';

// `/`: his landing page for a visitor, and straight on to the goal for a person signed in on this
// browser (the product sets the hint while someone is signed in, and clears it when they sign out).

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
  });

  it('sends a person signed in on this browser to their goal', async () => {
    jar.values.set(SIGNED_IN_COOKIE, '1');
    sent.to.mockClear();
    await LandingPage();
    expect(sent.to).toHaveBeenCalledWith('/goal');
  });
});
