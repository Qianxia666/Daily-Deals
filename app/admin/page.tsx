import type { Metadata } from 'next';
import { AdminDashboard } from '@/components/admin-dashboard';
import { AdminLogin } from '@/components/admin-login';
import { isAdmin } from '@/lib/admin';

export const metadata: Metadata = {
  title: '管理后台 · 每日优惠情报',
};

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const authed = await isAdmin();
  return authed ? <AdminDashboard /> : <AdminLogin />;
}
