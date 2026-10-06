import type { Dictionary } from '../../i18n';
import type { ThemeGroup } from './themes';

/** Each theme sleeve the plan holds: the share the person set for it, and why each name is on its list. */
export function ThemeBlock({
  themes,
  t,
  share,
}: {
  themes: ThemeGroup[];
  t: Dictionary;
  share: (bps: number) => string;
}) {
  if (themes.length === 0) return null;
  return (
    <div data-ui="plan-themes" className="flex flex-col gap-3">
      <h3 className="text-[0.8125rem]/5 font-medium">{t.plan.theme.label}</h3>
      {themes.map((g) => (
        <div key={g.theme} data-theme={g.theme} className="flex flex-col gap-1">
          <p className="text-body font-medium">
            {g.shareBps === null ? g.theme : t.plan.theme.share(g.theme, share(g.shareBps))}
          </p>
          <ul className="flex max-w-(--tf-measure-body) flex-col gap-1 text-body-sm text-muted-foreground">
            {g.names.map((n) => (
              <li key={`${n.line.assetId}:${n.line.viaIndex ?? ''}`}>{n.why}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
