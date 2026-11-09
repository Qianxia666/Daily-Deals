import type { Metadata } from 'next';
import { AdminDashboard } from '@/components/admin-dashboard';
import { AdminLogin } from '@/components/admin-login';
import { isAdmin } from '@/lib/admin';
import { getSiteSettings } from '@/lib/runtime-settings';

export async function generateMetadata(): Promise<Metadata> {
  const site = getSiteSettings();
  return {
    title: `管理后台 · ${site.title}`,
    description: site.tagline,
    robots: { index: false, follow: false },
  };
}

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const authed = await isAdmin();
  return authed ? <AdminDashboard /> : <AdminLogin />;
}
