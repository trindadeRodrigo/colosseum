import { MethodologyPage } from '../../../../features/portfolio-section/MethodologyPage';
import { sectionMetadata } from '../../../../features/portfolio-section/metadata';

// How the section reads a person's plans: what a snapshot is, what each status means, where each
// figure comes from, and what the pages cannot say yet. The words are in the section's dictionary
// (i18n/portfolio/<lang>/methodology.ts), in both languages.

export function generateMetadata() {
  return sectionMetadata('methodology');
}

export default function Methodology() {
  return <MethodologyPage />;
}
