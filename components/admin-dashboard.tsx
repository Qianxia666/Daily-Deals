'use client';

import {
  ArrowDown,
  ArrowUp,
  LoaderCircle,
  LogOut,
  Megaphone,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AdminData,
  AdminSource,
  RuntimeSettingView,
  SourceKind,
} from '@/lib/types';
import { cn } from '@/lib/utils';
import { AdminInviteCodes } from './admin-invite-codes';
import { AdminUserManager } from './admin-user-manager';
import { NotificationSettings } from './notification-settings';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Switch } from './ui/switch';

const KIND_LABELS: Record<SourceKind, string> = {
  rss: 'RSS / Atom',
  epic: 'Epic 官方接口',
  linuxdo: 'linux.do 专用',
  xianbao: '线报酷专用',
};

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function StatusBadge({ ok }: { ok: boolean | null }) {
  const label = ok === null ? '未抓取' : ok ? '正常' : '异常';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium leading-4',
        ok === null && 'border-line bg-slate-50 text-slate-500',
        ok === true &&
          'border-emerald-200 bg-emerald-50 text-emerald-700',
        ok === false && 'border-red-200 bg-red-50 text-red-700',
      )}
    >
      {label}
    </span>
  );
}

function buildRuntimeValues(
  fields: RuntimeSettingView[],
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of fields) values[field.key] = field.value;
  return values;
}

export function AdminDashboard() {
  const [data, setData] = useState<AdminData | null>(null);
  const [sources, setSources] = useState<AdminSource[]>([]);
  const [announcementEnabled, setAnnouncementEnabled] = useState(false);
  const [announcementText, setAnnouncementText] = useState('');
  const [runtimeValues, setRuntimeValues] = useState<Record<string, string>>(
    {},
  );
  const [newSource, setNewSource] = useState({
    name: '',
    id: '',
    url: '',
    kind: 'rss' as 'rss' | 'epic',
    refreshMinutes: '',
  });
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingAnnouncement, setSavingAnnouncement] = useState(false);
  const [adding, setAdding] = useState(false);
  const [rebuildingIndex, setRebuildingIndex] = useState(false);
  const [backfillingTags, setBackfillingTags] = useState(false);
  const [tagActionBusy, setTagActionBusy] = useState<string | null>(null);
  const [notifyBusy, setNotifyBusy] = useState<string | null>(null);
  const [notifyResult, setNotifyResult] = useState<{
    kind: string;
    ok: boolean;
    text: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<{
    type: 'ok' | 'error';
    text: string;
  } | null>(null);

  const applyPayload = useCallback((payload: AdminData) => {
    setData(payload);
    setSources(payload.sources);
    setAnnouncementEnabled(payload.announcement.enabled);
    setAnnouncementText(payload.announcement.text);
    setRuntimeValues(buildRuntimeValues(payload.runtimeSettings));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);

    try {
      const response = await fetch('/api/admin/data', {
        cache: 'no-store',
      });

      if (response.status === 401) {
        window.location.reload();
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      applyPayload((await response.json()) as AdminData);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [applyPayload]);

  useEffect(() => {
    void load();
  }, [load]);

  const runtimeGroups = useMemo(() => {
    const groups = new Map<string, RuntimeSettingView[]>();
    for (const field of data?.runtimeSettings ?? []) {
      const list = groups.get(field.group) ?? [];
      list.push(field);
      groups.set(field.group, list);
    }
    return [...groups.entries()];
  }, [data]);

  const pendingTagCandidates = useMemo(
    () =>
      (data?.tagCandidates ?? []).filter(
        (item) => item.status === 'pending',
      ),
    [data],
  );

  const move = (index: number, delta: number) => {
    setSources((previous) => {
      const target = index + delta;
      if (target < 0 || target >= previous.length) return previous;
      const next = [...previous];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const patchSource = (id: string, patch: Partial<AdminSource>) => {
    setSources((previous) =>
      previous.map((source) =>
        source.id === id ? { ...source, ...patch } : source,
      ),
    );
  };

  const save = async () => {
    if (saving) return;

    setSaving(true);
    setError(null);
    setNotice(null);
    setSaveState(null);

    try {
      const response = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          announcement: {
            enabled: announcementEnabled,
            text: announcementText,
          },
          sources: sources.map((source) => ({
            id: source.id,
            hidden: source.hidden,
            refreshMinutes: source.refreshMinutes,
            name: source.name,
            url: source.url,
            kind: source.kind,
          })),
          runtimeEnv: runtimeValues,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(payload?.error ?? `保存失败（HTTP ${response.status}）`);
      }

      applyPayload((await response.json()) as AdminData);
      setNotice('设置已保存，运行时配置已立即生效');
      window.setTimeout(() => setNotice(null), 3000);
      setSaveState({
        type: 'ok',
        text: `已保存，配置立即生效（${new Date().toLocaleTimeString('zh-CN', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        })}）`,
      });
    } catch (saveError) {
      const message =
        saveError instanceof Error ? saveError.message : '保存失败';
      setError(message);
      setSaveState({ type: 'error', text: message });
    } finally {
      setSaving(false);
    }
  };

  const saveAnnouncement = async () => {
    if (savingAnnouncement) return;

    setSavingAnnouncement(true);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          announcement: {
            enabled: announcementEnabled,
            text: announcementText,
          },
        }),
      });

      if (response.status === 401) {
        window.location.reload();
        return;
      }
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(payload?.error ?? `保存失败（HTTP ${response.status}）`);
      }

      const payload = (await response.json()) as AdminData;
      setData((previous) =>
        previous
          ? { ...previous, announcement: payload.announcement }
          : previous,
      );
      setNotice('公告已保存');
      window.setTimeout(() => setNotice(null), 3000);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存失败');
    } finally {
      setSavingAnnouncement(false);
    }
  };

  const addSource = async () => {
    if (adding) return;

    const name = newSource.name.trim();
    const url = newSource.url.trim();
    if (!name || !url) {
      setError('请填写来源名称和链接');
      return;
    }

    setAdding(true);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch('/api/admin/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          name,
          id: newSource.id.trim(),
          url,
          kind: newSource.kind,
          refreshMinutes: newSource.refreshMinutes.trim(),
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(payload?.error ?? `添加失败（HTTP ${response.status}）`);
      }

      applyPayload((await response.json()) as AdminData);
      setNewSource({
        name: '',
        id: '',
        url: '',
        kind: 'rss',
        refreshMinutes: '',
      });
      setNotice('来源已添加，将按刷新间隔自动抓取');
      window.setTimeout(() => setNotice(null), 3000);
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : '添加失败');
    } finally {
      setAdding(false);
    }
  };

  const removeSource = async (source: AdminSource) => {
    if (
      !window.confirm(
        `确定删除来源「${source.name}」？该来源已入库的条目也会一并删除。`,
      )
    ) {
      return;
    }

    setError(null);
    setNotice(null);

    try {
      const response = await fetch('/api/admin/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', id: source.id }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(payload?.error ?? `删除失败（HTTP ${response.status}）`);
      }

      applyPayload((await response.json()) as AdminData);
      setNotice('来源已删除');
      window.setTimeout(() => setNotice(null), 3000);
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : '删除失败');
    }
  };

  const triggerRefresh = async () => {
    if (triggering) return;

    setTriggering(true);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch('/api/fetch', { method: 'POST' });
      if (response.status === 401) {
        window.location.reload();
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      setNotice('已触发抓取，抓取完成后可点击「重新加载」查看最新结果');
      window.setTimeout(() => setNotice(null), 4000);
    } catch (triggerError) {
      setError(
        triggerError instanceof Error ? triggerError.message : '触发抓取失败',
      );
    } finally {
      setTriggering(false);
    }
  };

  const rebuildIndex = async () => {
    if (rebuildingIndex) return;

    setRebuildingIndex(true);
    setError(null);
    setNotice(null);

    const applyStatus = (searchIndex: AdminData['searchIndex']) => {
      setData((previous) =>
        previous ? { ...previous, searchIndex } : previous,
      );
    };

    try {
      const response = await fetch('/api/admin/search-index', {
        method: 'POST',
      });
      if (response.status === 401) {
        window.location.reload();
        return;
      }

      const payload = (await response.json().catch(() => null)) as
        | {
            searchIndex?: AdminData['searchIndex'];
            error?: string;
          }
        | null;

      if (!response.ok) {
        throw new Error(payload?.error ?? `HTTP ${response.status}`);
      }

      let searchIndex = payload?.searchIndex;
      if (!searchIndex) throw new Error('未返回索引状态');
      applyStatus(searchIndex);

      // 后台异步重建，轮询进度直到结束。
      while (searchIndex.rebuilding) {
        await new Promise((resolve) => window.setTimeout(resolve, 800));
        const statusResponse = await fetch('/api/admin/search-index', {
          cache: 'no-store',
        });
        if (!statusResponse.ok) break;

        const statusPayload = (await statusResponse.json().catch(() => null)) as
          | { searchIndex?: AdminData['searchIndex'] }
          | null;
        if (!statusPayload?.searchIndex) break;

        searchIndex = statusPayload.searchIndex;
        applyStatus(searchIndex);
      }

      if (searchIndex.lastError) {
        setError(`索引重建失败：${searchIndex.lastError}`);
      } else {
        setNotice(
          `索引重建完成：${searchIndex.indexed} / ${searchIndex.deals} 条`,
        );
        window.setTimeout(() => setNotice(null), 5000);
      }
    } catch (rebuildError) {
      setError(
        rebuildError instanceof Error ? rebuildError.message : '重建索引失败',
      );
    } finally {
      setRebuildingIndex(false);
    }
  };

  const runTagAction = async (
    action: 'promote' | 'block' | 'merge',
    tag: string,
  ) => {
    if (tagActionBusy) return;

    let target: string | undefined;
    if (action === 'merge') {
      const input = window.prompt(`把「${tag}」合并到哪个标签？`, '');
      target = input?.trim() || undefined;
      if (!target) return;
      if (target === tag) {
        setError('不能合并到自身');
        return;
      }
    }

    setTagActionBusy(tag);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch('/api/admin/tag-candidates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, tag, target }),
      });

      if (response.status === 401) {
        window.location.reload();
        return;
      }

      const payload = (await response.json().catch(() => null)) as
        | {
            tagCandidates?: AdminData['tagCandidates'];
            tags?: AdminData['tags'];
            error?: string;
          }
        | null;

      if (!response.ok) {
        throw new Error(payload?.error ?? `HTTP ${response.status}`);
      }

      setData((previous) =>
        previous
          ? {
              ...previous,
              tagCandidates:
                payload?.tagCandidates ?? previous.tagCandidates,
              tags: payload?.tags ?? previous.tags,
            }
          : previous,
      );
      setNotice(
        action === 'promote'
          ? `已转正「${tag}」`
          : action === 'block'
            ? `已屏蔽「${tag}」`
            : `已把「${tag}」合并到「${target}」`,
      );
      window.setTimeout(() => setNotice(null), 3000);
    } catch (actionError) {
      setError(
        actionError instanceof Error ? actionError.message : '操作失败',
      );
    } finally {
      setTagActionBusy(null);
    }
  };

  const backfillTags = async (force = false) => {
    if (backfillingTags) return;

    if (
      force &&
      !window.confirm(
        '将重新调用 AI 为全部在架优惠打标签（约 1000 条会消耗较多接口额度），是否继续？',
      )
    ) {
      return;
    }

    setBackfillingTags(true);
    setError(null);
    setNotice(null);

    const applyStatus = (tags: AdminData['tags']) => {
      setData((previous) => (previous ? { ...previous, tags } : previous));
    };

    try {
      const response = await fetch('/api/admin/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force }),
      });
      if (response.status === 401) {
        window.location.reload();
        return;
      }

      const payload = (await response.json().catch(() => null)) as
        | { tags?: AdminData['tags']; error?: string }
        | null;

      if (!response.ok) {
        throw new Error(payload?.error ?? `HTTP ${response.status}`);
      }

      let tags = payload?.tags;
      if (!tags) throw new Error('未返回标签状态');
      applyStatus(tags);

      while (tags.running) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        const statusResponse = await fetch('/api/admin/tags', {
          cache: 'no-store',
        });
        if (!statusResponse.ok) break;

        const statusPayload = (await statusResponse.json().catch(() => null)) as
          | { tags?: AdminData['tags'] }
          | null;
        if (!statusPayload?.tags) break;

        tags = statusPayload.tags;
        applyStatus(tags);
      }

      if (tags.lastError) {
        setError(`标签补全失败：${tags.lastError}`);
      } else {
        setNotice(
          `标签补全完成：本次新增 ${tags.taggedThisRun} 条${
            tags.failedThisRun > 0 ? `，失败 ${tags.failedThisRun} 条` : ''
          }`,
        );
        window.setTimeout(() => setNotice(null), 5000);
      }
    } catch (tagError) {
      setError(
        tagError instanceof Error ? tagError.message : '标签补全失败',
      );
    } finally {
      setBackfillingTags(false);
    }
  };

  const testNotify = async (kind: string) => {
    if (notifyBusy) return;
    setNotifyBusy(kind);
    setNotifyResult(null);

    try {
      const response = await fetch('/api/admin/notify/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? `HTTP ${response.status}`);
      }
      setNotifyResult({ kind, ok: true, text: '测试消息已发送' });
    } catch (testError) {
      setNotifyResult({
        kind,
        ok: false,
        text: testError instanceof Error ? testError.message : '发送失败',
      });
    } finally {
      setNotifyBusy(null);
    }
  };

  const logout = async () => {
    await fetch('/api/admin/logout', { method: 'POST' });
    window.location.href = '/';
  };

  if (loading && !data) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-paper">
        <LoaderCircle
          className="h-6 w-6 animate-spin text-slate-400"
          aria-label="正在加载"
        />
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-paper">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-start justify-between gap-3 px-4 py-4 sm:px-6">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-gold">
              Admin
            </p>
            <h1 className="mt-0.5 text-lg font-semibold tracking-tight text-ink">
              管理后台
            </h1>
            <p className="mt-0.5 text-[11px] text-slate-500">
              来源、刷新频率、公告与运行时配置
            </p>
          </div>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void triggerRefresh()}
              disabled={triggering}
            >
              <RefreshCw
                className={cn('h-4 w-4', triggering && 'animate-spin')}
                aria-hidden="true"
              />
              {triggering ? '触发中' : '立即抓取'}
            </Button>
            <a
              href="/"
              className="inline-flex h-9 cursor-pointer items-center rounded-lg border border-line bg-white px-3 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
            >
              返回首页
            </a>
            <Button variant="outline" size="sm" onClick={logout}>
              <LogOut className="h-4 w-4" aria-hidden="true" />
              退出
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl space-y-4 px-4 py-5 sm:px-6">
        {error && (
          <p
            className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700"
            role="alert"
          >
            {error}
          </p>
        )}
        {notice && (
          <p
            className="rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-2 text-xs text-emerald-700"
            role="status"
          >
            {notice}
          </p>
        )}

        <section className="rounded-2xl border border-line bg-white p-4 shadow-sm sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Megaphone
                className="h-4 w-4 text-amber-600"
                aria-hidden="true"
              />
              <h2 className="text-sm font-semibold text-ink">首页公告</h2>
            </div>
            <Switch
              checked={announcementEnabled}
              onCheckedChange={setAnnouncementEnabled}
              label={announcementEnabled ? '已开启' : '已关闭'}
            />
          </div>

          <textarea
            value={announcementText}
            onChange={(event) => setAnnouncementText(event.target.value)}
            maxLength={500}
            rows={4}
            placeholder="例如：本周新增 Epic 免费游戏，记得及时领取。"
            className="mt-3 w-full resize-y rounded-xl border border-line bg-white px-3 py-2.5 text-sm leading-relaxed text-ink transition-colors placeholder:text-slate-400 hover:border-slate-300 focus:border-slate-400"
          />
          <div className="mt-1 flex items-center justify-between text-[11px] text-slate-400">
            <span>开启后显示在首页统计栏下方</span>
            <span className="tabular-nums">{announcementText.length}/500</span>
          </div>
          <div className="mt-3 flex justify-end">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void saveAnnouncement()}
              disabled={savingAnnouncement}
            >
              {savingAnnouncement ? (
                <LoaderCircle
                  className="h-4 w-4 animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <Save className="h-4 w-4" aria-hidden="true" />
              )}
              {savingAnnouncement ? '保存中' : '保存公告'}
            </Button>
          </div>
        </section>

        <section className="rounded-2xl border border-line bg-white p-4 shadow-sm sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-ink">来源管理</h2>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                调整首页顺序、隐藏来源、修改地址，或为单个来源设置独立刷新间隔（留空使用全局间隔）。
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void load()}
              disabled={loading}
            >
              <RefreshCw
                className={cn('h-4 w-4', loading && 'animate-spin')}
                aria-hidden="true"
              />
              重新加载
            </Button>
          </div>

          <div className="mt-3 space-y-3">
            {sources.map((source, index) => (
              <div
                key={source.id}
                className={cn(
                  'rounded-xl border p-3 transition-colors',
                  source.hidden
                    ? 'border-slate-200 bg-slate-50'
                    : 'border-line bg-white',
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-medium text-ink">
                        {source.name}
                      </span>
                      <StatusBadge ok={source.ok} />
                      <span className="text-[10px] text-slate-400">
                        {source.id}
                      </span>
                      {source.builtin && (
                        <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] text-slate-500">
                          内置
                        </span>
                      )}
                      {source.hidden && (
                        <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] text-slate-500">
                          已隐藏
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-[11px] text-slate-500">
                      在架 {source.activeCount} · 本轮抓取 {source.count} ·
                      更新 {formatDateTime(source.fetchedAt)} · 间隔{' '}
                      {source.refreshMinutes
                        ? `${source.refreshMinutes} 分钟`
                        : `全局（${data?.globalIntervalMinutes ?? 120} 分钟）`}
                    </p>
                    {source.ok === false && (
                      <p className="mt-1 text-[11px] leading-relaxed text-red-700">
                        异常：{source.error ?? '未知错误'}
                      </p>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      aria-label={`上移 ${source.name}`}
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                      className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg border border-line bg-white text-slate-600 transition-colors hover:bg-slate-50 disabled:pointer-events-none disabled:opacity-40"
                    >
                      <ArrowUp className="h-4 w-4" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      aria-label={`下移 ${source.name}`}
                      disabled={index === sources.length - 1}
                      onClick={() => move(index, 1)}
                      className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg border border-line bg-white text-slate-600 transition-colors hover:bg-slate-50 disabled:pointer-events-none disabled:opacity-40"
                    >
                      <ArrowDown className="h-4 w-4" aria-hidden="true" />
                    </button>
                    {!source.builtin && (
                      <button
                        type="button"
                        aria-label={`删除 ${source.name}`}
                        onClick={() => void removeSource(source)}
                        className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg border border-red-200 bg-white text-red-600 transition-colors hover:bg-red-50"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </div>

                <div className="mt-2 grid gap-2 border-t border-line pt-2 sm:grid-cols-2">
                  <label className="min-w-0 text-[11px] text-slate-500">
                    名称
                    <Input
                      value={source.name}
                      maxLength={30}
                      onChange={(event) =>
                        patchSource(source.id, { name: event.target.value })
                      }
                      className="mt-1"
                    />
                  </label>
                  <label className="min-w-0 text-[11px] text-slate-500">
                    {source.builtin ? '类型（内置解析器）' : '类型'}
                    {source.builtin ? (
                      <div className="mt-1 flex h-11 items-center rounded-xl border border-line bg-slate-50 px-3 text-sm text-slate-600">
                        {KIND_LABELS[source.kind] ?? source.kind}
                      </div>
                    ) : (
                      <select
                        value={source.kind}
                        onChange={(event) =>
                          patchSource(source.id, {
                            kind: event.target.value as SourceKind,
                          })
                        }
                        className="mt-1 h-11 w-full rounded-xl border border-line bg-white px-3 text-sm text-ink transition-colors hover:border-slate-300 focus:border-slate-400"
                      >
                        <option value="rss">RSS / Atom</option>
                        <option value="epic">Epic 官方接口</option>
                      </select>
                    )}
                  </label>
                  <label className="min-w-0 text-[11px] text-slate-500 sm:col-span-2">
                    抓取地址
                    <Input
                      value={source.url}
                      onChange={(event) =>
                        patchSource(source.id, { url: event.target.value })
                      }
                      className="mt-1"
                    />
                  </label>
                  <label className="min-w-0 text-[11px] text-slate-500">
                    独立刷新间隔（分钟）
                    <Input
                      type="number"
                      min={5}
                      max={1440}
                      value={source.refreshMinutes ?? ''}
                      placeholder={`留空 = 全局 ${data?.globalIntervalMinutes ?? 120}`}
                      onChange={(event) => {
                        const raw = event.target.value;
                        patchSource(source.id, {
                          refreshMinutes:
                            raw === '' ? null : Number.parseInt(raw, 10),
                        });
                      }}
                      className="mt-1"
                    />
                  </label>
                  <div className="flex items-end">
                    <Switch
                      checked={!source.hidden}
                      onCheckedChange={(checked) =>
                        patchSource(source.id, { hidden: !checked })
                      }
                      label={source.hidden ? '首页隐藏' : '首页显示'}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 rounded-xl border border-dashed border-line bg-slate-50/60 p-3">
            <div className="flex items-center gap-2">
              <Plus className="h-4 w-4 text-slate-600" aria-hidden="true" />
              <h3 className="text-xs font-semibold text-ink">添加网站来源</h3>
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <label className="min-w-0 text-[11px] text-slate-500">
                名称
                <Input
                  value={newSource.name}
                  maxLength={30}
                  placeholder="例如：什么值得买"
                  onChange={(event) =>
                    setNewSource((previous) => ({
                      ...previous,
                      name: event.target.value,
                    }))
                  }
                  className="mt-1"
                />
              </label>
              <label className="min-w-0 text-[11px] text-slate-500">
                标识（可选）
                <Input
                  value={newSource.id}
                  placeholder="留空自动生成，小写英文/数字/-"
                  onChange={(event) =>
                    setNewSource((previous) => ({
                      ...previous,
                      id: event.target.value,
                    }))
                  }
                  className="mt-1"
                />
              </label>
              <label className="min-w-0 text-[11px] text-slate-500 sm:col-span-2">
                RSS / 接口地址
                <Input
                  value={newSource.url}
                  placeholder="https://example.com/feed/"
                  onChange={(event) =>
                    setNewSource((previous) => ({
                      ...previous,
                      url: event.target.value,
                    }))
                  }
                  className="mt-1"
                />
              </label>
              <label className="min-w-0 text-[11px] text-slate-500">
                类型
                <select
                  value={newSource.kind}
                  onChange={(event) =>
                    setNewSource((previous) => ({
                      ...previous,
                      kind: event.target.value as 'rss' | 'epic',
                    }))
                  }
                  className="mt-1 h-11 w-full rounded-xl border border-line bg-white px-3 text-sm text-ink transition-colors hover:border-slate-300 focus:border-slate-400"
                >
                  <option value="rss">RSS / Atom</option>
                  <option value="epic">Epic 官方接口</option>
                </select>
              </label>
              <label className="min-w-0 text-[11px] text-slate-500">
                独立刷新间隔（分钟）
                <Input
                  type="number"
                  min={5}
                  max={1440}
                  value={newSource.refreshMinutes}
                  placeholder={`留空 = 全局 ${data?.globalIntervalMinutes ?? 120}`}
                  onChange={(event) =>
                    setNewSource((previous) => ({
                      ...previous,
                      refreshMinutes: event.target.value,
                    }))
                  }
                  className="mt-1"
                />
              </label>
            </div>
            <div className="mt-2 flex justify-end">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void addSource()}
                disabled={adding}
              >
                {adding ? (
                  <LoaderCircle
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Plus className="h-4 w-4" aria-hidden="true" />
                )}
                {adding ? '添加中' : '添加来源'}
              </Button>
            </div>
          </div>

          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="text-[11px] text-slate-500">
              最近抓取：{formatDateTime(data?.fetchedAt ?? null)}
            </p>
            <Button onClick={save} disabled={saving}>
              {saving ? (
                <LoaderCircle
                  className="h-4 w-4 animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <Save className="h-4 w-4" aria-hidden="true" />
              )}
              {saving ? '保存中' : '保存全部设置'}
            </Button>
          </div>
        </section>

        <section className="rounded-2xl border border-line bg-white p-4 shadow-sm sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-ink">搜索索引</h2>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                全文索引负责为 AI 搜索召回候选。索引与数据条数不一致、或修改了「索引文本最大长度」后，可在这里手动重建。
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void rebuildIndex()}
              disabled={rebuildingIndex || !data?.searchIndex.available}
            >
              <RefreshCw
                className={cn(
                  'h-4 w-4',
                  (rebuildingIndex || data?.searchIndex.rebuilding) &&
                    'animate-spin',
                )}
                aria-hidden="true"
              />
              {rebuildingIndex || data?.searchIndex.rebuilding
                ? '重建中'
                : '重建索引'}
            </Button>
          </div>

          <div className="mt-3 grid gap-2 text-[11px] text-slate-600 sm:grid-cols-3">
            <div className="rounded-xl border border-line bg-slate-50 px-3 py-2">
              状态：
              <span
                className={cn(
                  'font-medium',
                  data?.searchIndex.available
                    ? 'text-emerald-700'
                    : 'text-red-700',
                )}
              >
                {data?.searchIndex.available ? '可用' : '不可用'}
              </span>
            </div>
            <div className="rounded-xl border border-line bg-slate-50 px-3 py-2">
              已索引：
              <span className="font-medium tabular-nums text-ink">
                {data?.searchIndex.rebuilding
                  ? data.searchIndex.processed
                  : data?.searchIndex.indexed ?? 0}
              </span>{' '}
              / {data?.searchIndex.deals ?? 0} 条
              {data?.searchIndex.rebuilding ? '（重建中）' : ''}
            </div>
            <div className="rounded-xl border border-line bg-slate-50 px-3 py-2">
              最近重建：{formatDateTime(data?.searchIndex.builtAt ?? null)}
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-line bg-white p-4 shadow-sm sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-ink">品类标签</h2>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                新建优惠会在生成 AI 摘要时自动打上品类标签，让「奶茶」这类品类词也能命中蜜雪冰城、茶百道等品牌条目。这里用于补全历史数据。
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void backfillTags()}
                disabled={
                  backfillingTags ||
                  data?.tags.running ||
                  !data?.tags.enabled ||
                  (data?.tags.pending ?? 0) === 0
                }
              >
                <RefreshCw
                  className={cn(
                    'h-4 w-4',
                    (backfillingTags || data?.tags.running) && 'animate-spin',
                  )}
                  aria-hidden="true"
                />
                {backfillingTags || data?.tags.running
                  ? '补全中'
                  : '补全标签'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void backfillTags(true)}
                disabled={
                  backfillingTags || data?.tags.running || !data?.tags.enabled
                }
                title="修改词表或提议标签配置后，用此按钮让存量条目按新配置重新打标"
              >
                重新打标
              </Button>
            </div>
          </div>

          <div className="mt-3 grid gap-2 text-[11px] text-slate-600 sm:grid-cols-3">
            <div className="rounded-xl border border-line bg-slate-50 px-3 py-2">
              状态：
              <span
                className={cn(
                  'font-medium',
                  data?.tags.enabled ? 'text-emerald-700' : 'text-slate-500',
                )}
              >
                {data?.tags.enabled ? '已开启' : '已关闭'}
              </span>
            </div>
            <div className="rounded-xl border border-line bg-slate-50 px-3 py-2">
              已标注：
              <span className="font-medium tabular-nums text-ink">
                {data?.tags.tagged ?? 0}
              </span>{' '}
              / {data?.tags.total ?? 0} 条
            </div>
            <div className="rounded-xl border border-line bg-slate-50 px-3 py-2">
              待补全：
              <span className="font-medium tabular-nums text-ink">
                {data?.tags.pending ?? 0}
              </span>{' '}
              条
            </div>
          </div>

          {data?.tags.running ? (
            <div className="mt-3">
              <div className="flex items-center justify-between text-[11px] text-slate-500">
                <span>
                  处理中：{data.tags.processed} / {data.tags.batchTotal}
                </span>
                <span>
                  新增 {data.tags.taggedThisRun}，失败{' '}
                  {data.tags.failedThisRun}
                </span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-accent transition-all"
                  style={{
                    width: `${
                      data.tags.batchTotal > 0
                        ? Math.min(
                            100,
                            Math.round(
                              (data.tags.processed / data.tags.batchTotal) *
                                100,
                            ),
                          )
                        : 0
                    }%`,
                  }}
                />
              </div>
            </div>
          ) : null}

          {data?.tags.lastError ? (
            <p className="mt-3 text-[11px] text-red-600">
              {data.tags.lastError}
            </p>
          ) : null}
        </section>

        <section className="rounded-2xl border border-line bg-white p-4 shadow-sm sm:p-5">
          <div>
            <h2 className="text-sm font-semibold text-ink">标签候选</h2>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
              AI 在词表外提出的新品类词会先进入候选池，立即参与搜索但不会出现在前台标签建议里。被{' '}
              {data?.tags.promoteThreshold ?? 3} 条以上优惠使用后可一键转正；转正后并入受控词表，也可合并到已有标签或直接屏蔽。
            </p>
          </div>

          {pendingTagCandidates.length === 0 ? (
            <p className="mt-3 rounded-xl border border-dashed border-line bg-slate-50 px-3 py-4 text-center text-[11px] text-slate-500">
              暂无待审核候选
            </p>
          ) : (
            <div className="mt-3 space-y-2">
              {pendingTagCandidates.map((item) => {
                const ready =
                  item.count >= (data?.tags.promoteThreshold ?? 3);
                const busy = tagActionBusy === item.tag;

                return (
                  <div
                    key={item.tag}
                    className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-slate-50 px-3 py-2"
                  >
                    <span className="text-sm font-medium text-ink">
                      {item.tag}
                    </span>
                    <span className="text-[11px] tabular-nums text-slate-500">
                      {item.count} 条
                    </span>
                    {ready && (
                      <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                        可转正
                      </span>
                    )}
                    <div className="ml-auto flex items-center gap-1.5">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={tagActionBusy !== null}
                        onClick={() => void runTagAction('promote', item.tag)}
                      >
                        转正
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={tagActionBusy !== null}
                        onClick={() => void runTagAction('merge', item.tag)}
                      >
                        合并
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={tagActionBusy !== null}
                        onClick={() => void runTagAction('block', item.tag)}
                      >
                        {busy ? '处理中…' : '屏蔽'}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <AdminUserManager />

        <AdminInviteCodes />

        <section className="rounded-2xl border border-line bg-white p-4 shadow-sm sm:p-5">
          <div>
            <h2 className="text-sm font-semibold text-ink">
              刷新与运行时配置
            </h2>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
              全局刷新间隔、AI 接口、代理与管理员密码都在这里设置。保存后立即生效；标注「需重建容器」的容器级参数除外。
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-amber-700">
              这里的修改优先于服务器 .env，保存后立即生效；未在后台修改过的项会读取 .env，修改 .env 后需重建容器才会生效。
            </p>
          </div>

          <div className="mt-4 space-y-4">
            {runtimeGroups.map(([group, fields]) =>
              group === '通知渠道' ? (
                <div key={group}>
                  <h3 className="text-xs font-semibold text-slate-700">
                    {group}
                  </h3>
                  <NotificationSettings
                    fields={fields}
                    values={runtimeValues}
                    onChange={(key, value) =>
                      setRuntimeValues((previous) => ({
                        ...previous,
                        [key]: value,
                      }))
                    }
                    onTest={(kind) => void testNotify(kind)}
                    busy={notifyBusy}
                    result={notifyResult}
                  />
                </div>
              ) : (
              <div key={group}>
                <h3 className="text-xs font-semibold text-slate-700">
                  {group}
                </h3>
                <div className="mt-2 grid gap-3 sm:grid-cols-2">
                  {fields.map((field) => {
                    const inactive =
                      field.key === 'AI_SEARCH_DAYS' &&
                      (runtimeValues.AI_SEARCH_SCOPE ?? 'active') !== 'days';

                    return (
                    <label
                      key={field.key}
                      className={cn(
                        'min-w-0 text-[11px] text-slate-500',
                        field.type === 'textarea' && 'sm:col-span-2',
                      )}
                    >
                      <span className="flex flex-wrap items-center gap-1.5">
                        {field.label}
                        {field.restartRequired && (
                          <span className="rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[9px] text-amber-700">
                            需重建容器
                          </span>
                        )}
                        {field.key.startsWith('AI_TAGS_') && (
                          <span className="rounded-full border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[9px] text-sky-700">
                            需重新打标
                          </span>
                        )}
                        <span
                          className={cn(
                            'rounded-full border px-1.5 py-0.5 text-[9px]',
                            field.source === 'admin'
                              ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                              : 'border-line bg-slate-50 text-slate-500',
                          )}
                        >
                          {field.source === 'admin'
                            ? '后台生效'
                            : field.source === 'env'
                              ? '.env 生效'
                              : '默认值'}
                        </span>
                        {field.secret && field.configured && (
                          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[9px] text-emerald-700">
                            已设置
                          </span>
                        )}
                      </span>

                      {field.type === 'select' ? (
                        <select
                          value={runtimeValues[field.key] ?? ''}
                          onChange={(event) =>
                            setRuntimeValues((previous) => ({
                              ...previous,
                              [field.key]: event.target.value,
                            }))
                          }
                          className="mt-1 h-11 w-full rounded-xl border border-line bg-white px-3 text-sm text-ink transition-colors hover:border-slate-300 focus:border-slate-400"
                        >
                          {(field.options ?? []).map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      ) : field.type === 'textarea' ? (
                        <textarea
                          rows={6}
                          value={runtimeValues[field.key] ?? ''}
                          placeholder={field.description}
                          onChange={(event) =>
                            setRuntimeValues((previous) => ({
                              ...previous,
                              [field.key]: event.target.value,
                            }))
                          }
                          className="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2 text-sm leading-relaxed text-ink transition-colors hover:border-slate-300 focus:border-slate-400"
                        />
                      ) : (
                        <Input
                          type={
                            field.type === 'password'
                              ? 'password'
                              : field.type === 'number'
                                ? 'number'
                                : 'text'
                          }
                          min={field.min}
                          max={field.max}
                          value={runtimeValues[field.key] ?? ''}
                          placeholder={
                            field.secret && field.configured
                              ? '已设置，留空保持不变'
                              : field.description
                          }
                          onChange={(event) =>
                            setRuntimeValues((previous) => ({
                              ...previous,
                              [field.key]: event.target.value,
                            }))
                          }
                          className="mt-1"
                          disabled={inactive}
                        />
                      )}

                      <span className="mt-1 block text-[10px] leading-relaxed text-slate-400">
                        {inactive
                          ? '当前「AI 搜索范围」为所有在架优惠，此项不生效；切换为按天数后才使用。'
                          : field.description}
                        {field.key.startsWith('AI_TAGS_') && (
                          <span className="mt-0.5 block text-amber-600">
                            只对之后新打标的优惠生效；要让存量数据按新配置更新，请在「品类标签」里点「重新打标」。
                          </span>
                        )}
                      </span>
                    </label>
                    );
                  })}
                </div>
              </div>
              ),
            )}
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
            {saveState && (
              <span
                className={cn(
                  'text-[11px]',
                  saveState.type === 'ok'
                    ? 'text-emerald-600'
                    : 'text-red-600',
                )}
                role={saveState.type === 'ok' ? 'status' : 'alert'}
              >
                {saveState.text}
              </span>
            )}
            <Button onClick={save} disabled={saving}>
              {saving ? (
                <LoaderCircle
                  className="h-4 w-4 animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <Save className="h-4 w-4" aria-hidden="true" />
              )}
              {saving ? '保存中' : '保存全部设置'}
            </Button>
          </div>
        </section>
      </main>
    </div>
  );
}
