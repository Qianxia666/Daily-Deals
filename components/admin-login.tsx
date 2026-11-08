'use client';

import { ArrowLeft, LoaderCircle, LockKeyhole } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';

export function AdminLogin() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || !password) return;

    setPending(true);
    setError(null);

    try {
      const response = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(payload?.error ?? `登录失败（HTTP ${response.status}）`);
      }

      window.location.reload();
    } catch (loginError) {
      setError(
        loginError instanceof Error ? loginError.message : '登录失败',
      );
      setPending(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-paper px-4 py-12">
      <div className="w-full max-w-sm">
        <a
          href="/"
          className="mb-6 inline-flex items-center gap-1.5 text-xs text-slate-500 transition-colors hover:text-ink"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          返回首页
        </a>

        <div className="rounded-2xl border border-line bg-white p-6 shadow-sm">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-slate-600">
            <LockKeyhole className="h-5 w-5" aria-hidden="true" />
          </div>
          <h1 className="mt-4 text-lg font-semibold tracking-tight text-ink">
            管理员登录
          </h1>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            仅管理员可访问，用于管理来源状态、排序与首页公告。
          </p>

          <form onSubmit={submit} className="mt-5 space-y-3">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-slate-600">
                管理密码
              </span>
              <Input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="请输入管理密码"
                autoComplete="current-password"
                autoFocus
                required
              />
            </label>

            {error && (
              <p
                className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700"
                role="alert"
              >
                {error}
              </p>
            )}

            <Button type="submit" disabled={pending} className="w-full">
              {pending && (
                <LoaderCircle
                  className="h-4 w-4 animate-spin"
                  aria-hidden="true"
                />
              )}
              {pending ? '登录中' : '登录'}
            </Button>
          </form>
        </div>

        <p className="mt-4 text-center text-[11px] text-slate-400">
          密码可在服务端环境变量或后台运行时配置中修改
        </p>
      </div>
    </div>
  );
}
