'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

// A link drawn as a button (components/ui/Button.tsx, with an `href`) is a plain anchor: the
// primitive reaches no router, so the partner embed can use it. Inside the product's shell a click on
// one that leads to a page of this app goes through the router, with no reload of the whole page (the
// flow audit, finding 33: "See your plan", "See your portfolio"). A click with a key held, on another
// button of the mouse, on a link to another site, to a fragment or to a new tab is left to the browser.

/** Where the click leads through the router, or null when it is the browser's to follow. */
export function routedHref(event: MouseEvent): string | null {
  if (event.defaultPrevented || event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const target = event.target instanceof Element ? event.target : null;
  const link = target?.closest('a[data-ui="button"][href]');
  if (!link || link.hasAttribute('target') || link.hasAttribute('download')) return null;
  const href = link.getAttribute('href') ?? '';
  return /^\/(?!\/)/.test(href) ? href : null;
}

export function RouterLinks() {
  const router = useRouter();
  useEffect(() => {
    const follow = (event: MouseEvent) => {
      const href = routedHref(event);
      if (href === null) return;
      event.preventDefault();
      router.push(href);
    };
    document.addEventListener('click', follow);
    return () => document.removeEventListener('click', follow);
  }, [router]);
  return null;
}
