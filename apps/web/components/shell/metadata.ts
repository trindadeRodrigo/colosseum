import { dictionary } from '../../i18n';
import { readPreferences } from '../../i18n/server';

// What a browser tab, a bookmark and a link preview say about each product page, in the language of
// the view: its own title, with the product's name after it, and its own description.

/** The layout's: the pattern of every title, and what a page that names nothing gets. */
export async function shellMetadata() {
  const { lang } = await readPreferences();
  return {
    title: { template: '%s · tenonfi', default: 'tenonfi' },
    description: dictionary(lang).goal.title,
  };
}

export async function goalMetadata() {
  const { lang } = await readPreferences();
  const t = dictionary(lang);
  return { title: t.goal.composer.label, description: t.goal.title };
}

export async function monitorMetadata() {
  const { lang } = await readPreferences();
  const t = dictionary(lang);
  return { title: t.shell.portfolio, description: t.portfolio.lead };
}

export async function signInMetadata() {
  const { lang } = await readPreferences();
  const t = dictionary(lang);
  return { title: t.shell.signIn, description: t.signIn.title };
}

export async function planMetadata() {
  const { lang } = await readPreferences();
  const t = dictionary(lang);
  return { title: t.plan.title, description: t.plan.buy };
}

export async function buyMetadata() {
  const { lang } = await readPreferences();
  const t = dictionary(lang);
  return { title: t.buy.title, description: t.buy.funding.title };
}

export async function orderMetadata() {
  const { lang } = await readPreferences();
  const t = dictionary(lang);
  return { title: t.order.title, description: t.order.review.title };
}
