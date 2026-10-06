import { dictionary } from '../../../../i18n';
import { readPreferences } from '../../../../i18n/server';

// How Bearing measures (method risk-0.3): what is measured, what a number means and what it is not.
// From docs/risk/PLAN-RISK.md §4 and Appendix A; keep the two in step. It was /risk/methodology. The
// words are in the dictionary (`bearing.methodology`), in both languages.

export async function generateMetadata() {
  const t = dictionary((await readPreferences()).lang).bearing;
  return {
    title: `${t.pages.methodology.label} · ${t.head}`,
    description: t.pages.methodology.lede,
  };
}

export default async function Methodology() {
  const t = dictionary((await readPreferences()).lang).bearing.methodology;
  return (
    <article className="mt-6 max-w-[72ch] text-body-sm">
      <h2 className="mt-8 mb-2 text-b-section font-semibold">{t.measured}</h2>
      <p>{t.measuredText}</p>
      <h2 className="mt-8 mb-2 text-b-section font-semibold">{t.means}</h2>
      <ul className="list-disc space-y-1.5 pl-5">
        {t.meansItems.map(([term, text]) => (
          <li key={term}>
            <b>{term}</b>
            {text.startsWith(':') ? '' : ' '}
            {text}
          </li>
        ))}
      </ul>
      <h2 className="mt-8 mb-2 text-b-section font-semibold">{t.isNot}</h2>
      <ul className="list-disc space-y-1.5 pl-5">
        {t.isNotItems.map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
    </article>
  );
}
