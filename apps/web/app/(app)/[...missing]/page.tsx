import { notFound } from 'next/navigation';
import { dictionary } from '../../../i18n';
import { readPreferences } from '../../../i18n/server';

// An address no route answers. The app has more than one root layout, so there is no one place for a
// "not found" page and Next would answer with a bare one, outside all of them. This route catches
// such an address and answers 404 inside the product's shell (not-found.tsx beside the layout). Every
// other route is more specific and wins over it.

export async function generateMetadata() {
  const { lang } = await readPreferences();
  return { title: dictionary(lang).shell.missing.title };
}

export default function Missing(): never {
  notFound();
}
