import Link from 'next/link';
import { buttonClass } from '../../components/ui/button-class';
import { PAGE_TITLE } from '../../components/ui/heading';
import { dictionary } from '../../i18n';
import { readPreferences } from '../../i18n/server';

// What a product route says when it has nothing at an address: the catch-all beside this file, and
// any page under the product's layout that calls `notFound()`. In the product's shell, with one way on.

export default async function NotFound() {
  const { lang } = await readPreferences();
  const t = dictionary(lang).shell.missing;
  return (
    <section
      data-ui="not-found"
      aria-labelledby="not-found-title"
      className="flex flex-col items-start gap-4"
    >
      <h1 id="not-found-title" className={PAGE_TITLE}>
        {t.title}
      </h1>
      <p className="max-w-(--tf-measure-body) text-body">{t.body}</p>
      <Link href="/goal" className={buttonClass({ variant: 'primary' })}>
        {t.action}
      </Link>
    </section>
  );
}
