import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AuthForm } from '@/components/auth-form';
import { getCurrentUser } from '@/lib/auth';
import {
  getRegistrationInviteCode,
  getRegistrationInviteRequired,
  getRegistrationOpen,
  getSiteSettings,
} from '@/lib/runtime-settings';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const site = getSiteSettings();
  return {
    title: `登录 · ${site.title}`,
    robots: { index: false, follow: false },
  };
}

function safeNext(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/account';
  return raw;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const params = await searchParams;
  const next = safeNext(params.next);

  const user = await getCurrentUser();
  if (user) redirect(next);

  return (
    <AuthForm
      site={getSiteSettings()}
      registrationOpen={getRegistrationOpen()}
      inviteRequired={
        getRegistrationInviteRequired() ||
        Boolean(getRegistrationInviteCode())
      }
      next={next}
    />
  );
}
