import { shelfMetadata } from '../../../components/shell/metadata';
import { ShelfScreen } from '../../../features/shared/ShelfScreen';

// The shared portfolios, those on the person's chain once signed in.

export function generateMetadata() {
  return shelfMetadata();
}

export default function ShelfPage() {
  return <ShelfScreen />;
}
