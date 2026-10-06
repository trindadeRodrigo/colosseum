import { EmbedGoal } from '../../../features/embed/EmbedGoal';
import { partnerTheme, themeStyle } from '../../../features/embed/theme';

// The partner embed: a goal read into limits, and the way out to build the plan in tenonfi. The host
// names its skin in the address (features/embed/theme.ts).

export default async function EmbedGoalPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <EmbedGoal style={themeStyle(partnerTheme(await searchParams))} />;
}
