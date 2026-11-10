'use client';

import { Copy, LoaderCircle, Plus, Ticket, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { InviteCode } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { Input } from './ui/input';

function formatDate(iso: string | null): string {
  if (!iso) return '永不过期';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function codeStatus(code: InviteCode): {
  label: string;
  tone: 'ok' | 'warn' | 'off';
} {
  if (code.disabled) return { label: '已停用', tone: 'off' };
  if (code.expiresAt && Date.parse(code.expiresAt) <= Date.now()) {
    return { label: '已过期', tone: 'off' };
  }
  if (code.maxUses > 0 && code.usedCount >= code.maxUses) {
    return { label: '已用完', tone: 'off' };
  }
  return { label: '可用', tone: 'ok' };
}

export function AdminInviteCodes() {
  const [codes, setCodes] = useState<InviteCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<{
    type: 'ok' | 'error';
    text: string;
  } | null>(null);
  const [form, setForm] = useState({
    count: '1',
    maxUses: '1',
    validityDays: '30',
    code: '',
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/admin/invites', {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as { codes: InviteCode[] };
      setCodes(payload.codes);
    } catch {
      setMessage({ type: 'error', text: '邀请码加载失败' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    if (creating) return;
    setCreating(true);
    setMessage(null);

    try {
      const response = await fetch('/api/admin/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          count: Number(form.count) || 1,
          maxUses: Number(form.maxUses) || 0,
          validityDays: Number(form.validityDays) || 0,
          code: form.code.trim(),
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: string; codes?: InviteCode[] }
        | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? '生成失败');
      }

      setMessage({
        type: 'ok',
        text: `已生成 ${payload?.codes?.length ?? 0} 个邀请码`,
      });
      setForm((previous) => ({ ...previous, code: '' }));
      await load();
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : '生成失败',
      });
    } finally {
      setCreating(false);
    }
  };

  const toggle = async (code: InviteCode) => {
    if (busy !== null) return;
    setBusy(code.id);
    setMessage(null);

    try {
      const response = await fetch(`/api/admin/invites/${code.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disabled: !code.disabled }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: string; codes?: InviteCode[] }
        | null;
      if (!response.ok) throw new Error(payload?.error ?? '操作失败');
      if (payload?.codes) setCodes(payload.codes);
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : '操作失败',
      });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (code: InviteCode) => {
    if (busy !== null) return;
    if (!window.confirm(`确定删除邀请码 ${code.code}？`)) return;

    setBusy(code.id);
    setMessage(null);

    try {
      const response = await fetch(`/api/admin/invites/${code.id}`, {
        method: 'DELETE',
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: string; codes?: InviteCode[] }
        | null;
      if (!response.ok) throw new Error(payload?.error ?? '删除失败');
      if (payload?.codes) setCodes(payload.codes);
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : '删除失败',
      });
    } finally {
      setBusy(null);
    }
  };

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setMessage({ type: 'ok', text: `已复制 ${code}` });
    } catch {
      setMessage({ type: 'error', text: '复制失败，请手动选择复制' });
    }
  };

  return (
    <section className="rounded-2xl border border-line bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Ticket className="h-4 w-4 text-gold" aria-hidden="true" />
          邀请码管理
        </h2>
        <span className="text-[11px] text-slate-400">
          共 {codes.length} 个
        </span>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
        可随时生成多个同时有效的邀请码，并单独控制有效期与使用次数。开启「注册必须使用邀请码」后生效。
      </p>

      <div className="mt-3 grid gap-2 sm:grid-cols-5">
        <label className="text-[11px] text-slate-500">
          数量
          <Input
            type="number"
            min={1}
            max={20}
            value={form.count}
            onChange={(event) =>
              setForm((previous) => ({ ...previous, count: event.target.value }))
            }
            className="mt-1 h-10"
            disabled={Boolean(form.code.trim())}
          />
        </label>
        <label className="text-[11px] text-slate-500">
          每码可用次数（0 不限）
          <Input
            type="number"
            min={0}
            max={1000}
            value={form.maxUses}
            onChange={(event) =>
              setForm((previous) => ({
                ...previous,
                maxUses: event.target.value,
              }))
            }
            className="mt-1 h-10"
          />
        </label>
        <label className="text-[11px] text-slate-500">
          有效期天数（0 永久）
          <Input
            type="number"
            min={0}
            max={3650}
            value={form.validityDays}
            onChange={(event) =>
              setForm((previous) => ({
                ...previous,
                validityDays: event.target.value,
              }))
            }
            className="mt-1 h-10"
          />
        </label>
        <label className="text-[11px] text-slate-500">
          自定义码（可选）
          <Input
            value={form.code}
            placeholder="留空自动生成"
            onChange={(event) =>
              setForm((previous) => ({ ...previous, code: event.target.value }))
            }
            className="mt-1 h-10"
          />
        </label>
        <div className="flex items-end">
          <Button
            className="h-10 w-full"
            disabled={creating}
            onClick={() => void create()}
          >
            {creating ? (
              <LoaderCircle
                className="h-3.5 w-3.5 animate-spin"
                aria-hidden="true"
              />
            ) : (
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            生成邀请码
          </Button>
        </div>
      </div>

      {message && (
        <p
          className={cn(
            'mt-3 rounded-lg px-3 py-2 text-[11px]',
            message.type === 'ok'
              ? 'bg-emerald-50 text-emerald-700'
              : 'bg-red-50 text-red-700',
          )}
        >
          {message.text}
        </p>
      )}

      {loading ? (
        <p className="mt-3 text-center text-xs text-slate-400">加载中…</p>
      ) : codes.length === 0 ? (
        <p className="mt-3 rounded-xl border border-dashed border-line px-4 py-6 text-center text-xs text-slate-400">
          还没有邀请码，生成后即可分享给新用户
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-line/70">
          {codes.map((code) => {
            const status = codeStatus(code);
            return (
              <li
                key={code.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2.5"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-semibold tracking-wider text-ink">
                      {code.code}
                    </code>
                    <span
                      className={cn(
                        'rounded-full border px-1.5 py-0.5 text-[9px]',
                        status.tone === 'ok'
                          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                          : status.tone === 'warn'
                            ? 'border-amber-200 bg-amber-50 text-amber-700'
                            : 'border-line bg-slate-50 text-slate-400',
                      )}
                    >
                      {status.label}
                    </span>
                  </div>
                  <p className="mt-1 text-[10px] text-slate-400">
                    已用 {code.usedCount}/
                    {code.maxUses > 0 ? code.maxUses : '不限'} · 有效期{' '}
                    {formatDate(code.expiresAt)} · 创建{' '}
                    {formatDate(code.createdAt)}
                  </p>
                </div>

                <div className="flex items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void copy(code.code)}
                  >
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                    复制
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => void toggle(code)}
                  >
                    {code.disabled ? '启用' : '停用'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy !== null || code.usedCount > 0}
                    onClick={() => void remove(code)}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
