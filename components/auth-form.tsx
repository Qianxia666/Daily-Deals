'use client';

import { LoaderCircle, Lock, Mail, Sparkles } from 'lucide-react';
import { useCallback, useState } from 'react';
import type { SiteSettings } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { Input } from './ui/input';

type Mode = 'login' | 'register';

export function AuthForm({
  site,
  registrationOpen,
  inviteRequired,
  next,
}: {
  site: SiteSettings;
  registrationOpen: boolean;
  inviteRequired: boolean;
  next: string;
}) {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [invite, setInvite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (busy) return;

      setBusy(true);
      setError(null);

      try {
        const response = await fetch(`/api/auth/${mode}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, invite }),
        });
        const payload = (await response.json().catch(() => null)) as {
          error?: unknown;
        } | null;

        if (!response.ok) {
          throw new Error(
            typeof payload?.error === 'string'
              ? payload.error
              : `HTTP ${response.status}`,
          );
        }

        window.location.href = next;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '操作失败');
        setBusy(false);
      }
    },
    [busy, email, invite, mode, next, password],
  );

  const switchMode = (nextMode: Mode) => {
    setMode(nextMode);
    setError(null);
  };

  return (
    <div className="relative isolate flex min-h-dvh items-center justify-center overflow-hidden px-4 py-12">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
        <div className="tech-aurora absolute inset-0" />
        <div className="tech-grid absolute inset-0" />
      </div>

      <div className="w-full max-w-sm">
        <a
          href="/"
          className="mb-6 inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 transition-colors hover:text-ink"
        >
          ← 返回首页
        </a>

        <div className="rounded-2xl border border-line bg-white p-6 shadow-sm">
          <p className="font-mono text-[10px] uppercase tracking-[0.32em] text-gold">
            {site.label}
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink">
            {mode === 'login' ? '登录账号' : '创建账号'}
          </h1>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            登录后可解锁 AI 搜索，并设置关键词订阅推送。
          </p>

          <div className="mt-5 flex rounded-xl bg-slate-100 p-1 text-xs font-medium">
            <button
              type="button"
              onClick={() => switchMode('login')}
              className={cn(
                'flex-1 cursor-pointer rounded-lg py-2 transition-colors',
                mode === 'login'
                  ? 'bg-white text-ink shadow-sm'
                  : 'text-slate-500 hover:text-ink',
              )}
            >
              登录
            </button>
            <button
              type="button"
              disabled={!registrationOpen}
              onClick={() => switchMode('register')}
              className={cn(
                'flex-1 cursor-pointer rounded-lg py-2 transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                mode === 'register'
                  ? 'bg-white text-ink shadow-sm'
                  : 'text-slate-500 hover:text-ink',
              )}
            >
              注册
            </button>
          </div>

          {!registrationOpen && (
            <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
              管理员已关闭自助注册，请使用已有账号登录。
            </p>
          )}

          <form onSubmit={submit} className="mt-4 space-y-3">
            <label className="block text-[11px] text-slate-500">
              邮箱
              <div className="relative mt-1">
                <Mail
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                  aria-hidden="true"
                />
                <Input
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  className="pl-10"
                />
              </div>
            </label>

            <label className="block text-[11px] text-slate-500">
              密码
              <div className="relative mt-1">
                <Lock
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                  aria-hidden="true"
                />
                <Input
                  type="password"
                  required
                  minLength={6}
                  maxLength={72}
                  autoComplete={
                    mode === 'login' ? 'current-password' : 'new-password'
                  }
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="至少 6 位"
                  className="pl-10"
                />
              </div>
            </label>

            {mode === 'register' && inviteRequired && (
              <label className="block text-[11px] text-slate-500">
                邀请码
                <Input
                  value={invite}
                  onChange={(event) => setInvite(event.target.value)}
                  placeholder="请输入管理员提供的邀请码"
                  className="mt-1"
                />
              </label>
            )}

            {error && (
              <p
                className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-[11px] text-red-700"
                role="alert"
              >
                {error}
              </p>
            )}

            <Button type="submit" disabled={busy} className="w-full">
              {busy ? (
                <LoaderCircle
                  className="h-4 w-4 animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <Sparkles className="h-4 w-4" aria-hidden="true" />
              )}
              {busy
                ? '处理中'
                : mode === 'login'
                  ? '登录'
                  : '注册并登录'}
            </Button>
          </form>

          <p className="mt-4 text-[10px] leading-relaxed text-slate-400">
            不提供邮箱验证与密码找回，请牢记密码。登录状态保持 30 天。
          </p>
        </div>
      </div>
    </div>
  );
}
