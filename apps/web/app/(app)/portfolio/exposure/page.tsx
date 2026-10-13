import { ExposurePage } from '../../../../features/portfolio-section/ExposurePage';
import { sectionMetadata } from '../../../../features/portfolio-section/metadata';

// What the person's plans add up to: their holdings by underlying and by issuer, chain by chain.

export function generateMetadata() {
  return sectionMetadata('exposure');
}

export default function Exposure() {
  return <ExposurePage />;
}
