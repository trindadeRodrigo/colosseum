import { monitorMetadata } from '../../../components/shell/metadata';
import { MonitorScreen } from '../../../features/portfolio/MonitorScreen';

// The monitor: the person's vaults on their chain, read from the API (GET /v1/portfolio).

export function generateMetadata() {
  return monitorMetadata();
}

export default function MonitorPage() {
  return <MonitorScreen />;
}
