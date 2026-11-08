import { DealsApp } from '@/components/deals-app';
import { getSiteSettings } from '@/lib/runtime-settings';

export const dynamic = 'force-dynamic';

export default function HomePage() {
  return <DealsApp initialSite={getSiteSettings()} />;
}
