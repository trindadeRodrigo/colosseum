import { redirect } from 'next/navigation';

// The section opens on its first page.
export default function AnalyticsHome() {
  redirect('/analytics/stocks');
}
