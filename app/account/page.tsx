import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AccountPanel } from '@/components/account-panel';
import { getCurrentUser } from '@/lib/auth';
import {
  getAiQuota,
  listChannels,
  listSubscriptions,
  listUserDeliveries,
} from '@/lib/db';
import {
  getAccountLimits,
  getAiSearchDailyLimit,
  getSiteSettings,
} from '@/lib/runtime-settings';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const site = getSiteSettings();
  return {
    title: `我的账号 · ${site.title}`,
    robots: { index: false, follow: false },
  };
}

export default async function AccountPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login?next=/account');

  return (
    <AccountPanel
      initialData={{
        user,
        aiQuota: getAiQuota(user.id, getAiSearchDailyLimit()),
        limits: getAccountLimits(),
        subscriptions: listSubscriptions(user.id),
        channels: listChannels(user.id),
        deliveries: listUserDeliveries(user.id),
      }}
    />
  );
}
