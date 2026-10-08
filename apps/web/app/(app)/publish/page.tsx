import { publishMetadata } from '../../../components/shell/metadata';
import { PublishScreen } from '../../../features/shared/PublishScreen';

// The publish form. The order it makes is reviewed and signed on the order screen.

export function generateMetadata() {
  return publishMetadata();
}

export default function PublishPage() {
  return <PublishScreen />;
}
