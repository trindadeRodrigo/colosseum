import { type AnchorHTMLAttributes, createElement, type ReactNode } from 'react';
import { vi } from 'vitest';

// What stands in for Next's router and link in the tests of the screens: there is no app router in a
// test, and what a screen does with one is all a test wants to see.
//
//   vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
//   vi.mock('next/link', () => import('../wallet/test/mock-next'));

export const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };
export const location = { pathname: '/goal' };

export const useRouter = () => router;
export const usePathname = () => location.pathname;

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children?: ReactNode };

/** `next/link`, as the anchor it renders. */
export default function Link({ children, ...rest }: LinkProps) {
  return createElement('a', rest, children);
}
