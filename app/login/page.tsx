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
  // 只允许站内相对路径；反斜杠会被部分浏览器当成协议相对地址。
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) {
    return '/account';
  }
  // 浏览器解析 URL 时会移除制表符/换行，"/\n/evil.com" 会变成 "//evil.com"。
  if (/[\u0000-\u001f\u007f\s]/.test(raw)) {
    return '/account';
  }
  // 最终用 URL 解析确认仍是同源路径，避免其它形式的协议相对地址绕过。
  try {
    const target = new URL(raw, 'http://site.invalid');
    if (target.origin !== 'http://site.invalid') return '/account';
  } catch {
    return '/account';
  }
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
