'use client';

import {
  BellRing,
  Bot,
  Check,
  Link2,
  LoaderCircle,
  LogOut,
  Plus,
  Send,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import type {
  AccountData,
  ChannelKind,
  DeliveryRecord,
  UserChannel,
} from '@/lib/types';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { Input } from './ui/input';

const CHANNEL_LABELS: Record<ChannelKind, string> = {
  wecom: '企业微信机器人',
  feishu: '飞书机器人',
  dingtalk: '钉钉机器人',
  bark: 'Bark 推送',
};

const CHANNEL_HINTS: Record<ChannelKind, string> = {
  wecom: '群机器人 Webhook，形如 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx',
  feishu: '群机器人 Webhook，形如 https://open.feishu.cn/open-apis/bot/v2/hook/xxx',
  dingtalk: '群机器人 Webhook，形如 https://oapi.dingtalk.com/robot/send?access_token=xxx',
  bark: '填写 Bark 设备 Key，或 https://api.day.app/ 开头的完整地址',
};

const STATUS_LABELS: Record<DeliveryRecord['status'], string> = {
  pending: '待发送',
  sent: '已推送',
  failed: '发送失败',
  digested: '已合并到摘要',
  skipped: '已跳过',
};

function formatTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function api<T>(url: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(url, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as
    | (T & { error?: unknown })
    | null;
  if (!response.ok) {
    throw new Error(
      payload && typeof payload.error === 'string'
        ? payload.error
        : `HTTP ${response.status}`,
    );
  }
  return payload as T;
}

export function AccountPanel({ initialData }: { initialData: AccountData }) {
  const [data, setData] = useState(initialData);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const next = await api<AccountData>('/api/account');
      setData(next);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '加载失败');
    }
  }, []);

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      if (busy) return;
      setBusy(true);
      setLoadError(null);
      try {
        await action();
        await reload();
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : '操作失败');
      } finally {
        setBusy(false);
      }
    },
    [busy, reload],
  );

  const quota = data.aiQuota;
  const quotaPercent =
    quota.limit > 0 ? Math.min(100, (quota.used / quota.limit) * 100) : 0;

  return (
    <div className="min-h-dvh bg-slate-50/60">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between gap-3 px-4">
          <a
            href="/"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 transition-colors hover:text-ink"
          >
            ← 返回首页
          </a>
          <div className="flex items-center gap-3">
            <span className="hidden max-w-[220px] truncate text-xs text-slate-500 sm:inline">
              {data.user.email}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                void api('/api/auth/logout', {}, 'POST').then(() => {
                  window.location.href = '/';
                })
              }
            >
              <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
              退出
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-5 px-4 py-6">
        <section className="rounded-2xl border border-line bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-gold">
                Account
              </p>
              <h1 className="mt-1 text-lg font-semibold text-ink">
                我的账号
              </h1>
              <p className="mt-0.5 text-xs text-slate-500">{data.user.email}</p>
            </div>
            <div className="min-w-[160px] rounded-xl border border-line bg-slate-50 px-3 py-2">
              <p className="flex items-center gap-1.5 text-[11px] text-slate-500">
                <Sparkles className="h-3.5 w-3.5 text-gold" aria-hidden="true" />
                今日 AI 搜索
              </p>
              <p className="mt-1 text-sm font-semibold text-ink">
                {quota.limit > 0 ? `${quota.used} / ${quota.limit}` : '不限次数'}
              </p>
              {quota.limit > 0 && (
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-200">
                  <div
                    className="h-full rounded-full bg-gold transition-all"
                    style={{ width: `${quotaPercent}%` }}
                  />
                </div>
              )}
            </div>
          </div>
        </section>

        <SubscriptionsSection data={data} busy={busy} run={run} />
        <ChannelsSection data={data} busy={busy} run={run} />
        <DeliveriesSection deliveries={data.deliveries} />

        {loadError && (
          <p className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-xs text-red-700">
            {loadError}
          </p>
        )}

        <p className="pb-6 text-center text-[10px] leading-relaxed text-slate-400">
          订阅匹配基于 AI 标签与标题关键词；命中后通过你绑定的机器人推送。
          每人每天最多推送 {data.limits.dailyPush} 条。
        </p>
      </main>
    </div>
  );
}

function SubscriptionsSection({
  data,
  busy,
  run,
}: {
  data: AccountData;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [keyword, setKeyword] = useState('');
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const add = () => {
    const value = keyword.trim();
    if (!value) return;
    void run(async () => {
      await api('/api/account/subscriptions', { keyword: value });
      setKeyword('');
    });
  };

  return (
    <section className="rounded-2xl border border-line bg-white p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <BellRing className="h-4 w-4 text-gold" aria-hidden="true" />
          关键词订阅
        </h2>
        <span className="text-[11px] text-slate-400">
          {data.subscriptions.length} / {data.limits.subscriptions}
        </span>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
        例如「奶茶」「Steam」「云服务器」。AI 给新优惠打标签或标题命中时，自动推送到你的机器人。
      </p>

      <div className="mt-3 flex gap-2">
        <Input
          value={keyword}
          maxLength={20}
          placeholder="输入想买的东西或品类"
          onChange={(event) => setKeyword(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') add();
          }}
        />
        <Button onClick={add} disabled={busy || !keyword.trim()}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          添加
        </Button>
      </div>

      {data.subscriptions.length === 0 ? (
        <p className="mt-4 rounded-xl border border-dashed border-line px-4 py-6 text-center text-xs text-slate-400">
          还没有订阅关键词
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-line/70">
          {data.subscriptions.map((item) => (
            <li key={item.id} className="py-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p
                    className={cn(
                      'truncate text-sm',
                      item.enabled ? 'text-ink' : 'text-slate-400 line-through',
                    )}
                  >
                    {item.keyword}
                  </p>
                  <p className="mt-0.5 text-[10px] text-slate-400">
                    添加于 {formatTime(item.createdAt)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <ToggleButton
                    active={item.enabled}
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        api('/api/account/subscriptions', {
                          id: item.id,
                          enabled: !item.enabled,
                        }, 'PATCH'),
                      )
                    }
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedId(expandedId === item.id ? null : item.id)
                    }
                    title="查看关联词"
                    aria-label={`查看「${item.keyword}」的关联词`}
                    aria-expanded={expandedId === item.id}
                    className={cn(
                      'inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg border transition-colors',
                      expandedId === item.id
                        ? 'border-gold/60 bg-gold/10 text-gold'
                        : 'border-line bg-white text-slate-400 hover:border-slate-300 hover:text-ink',
                    )}
                  >
                    <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  <IconButton
                    label="删除"
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm(`删除订阅「${item.keyword}」？`)) return;
                      void run(() =>
                        api('/api/account/subscriptions', { id: item.id }, 'DELETE'),
                      );
                    }}
                  />
                </div>
              </div>
              {expandedId === item.id && (
                <div className="mt-2 rounded-lg border border-line bg-slate-50/80 px-2.5 py-2 text-[10px] leading-relaxed text-slate-500">
                  {item.expansions.length > 0 ? (
                    <>
                      <span className="mr-1 text-slate-400">关联词</span>
                      {item.expansions.map((word) => (
                        <span
                          key={word}
                          className="mr-1 inline-block rounded border border-line bg-white px-1.5 py-0.5 text-slate-600"
                        >
                          {word}
                        </span>
                      ))}
                      {item.expansionSource === 'ai' && (
                        <span className="ml-1 text-gold">AI 拓展</span>
                      )}
                    </>
                  ) : (
                    'AI 未为这个词生成关联词，当前仅匹配关键词本身。'
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ChannelsSection({
  data,
  busy,
  run,
}: {
  data: AccountData;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<ChannelKind>('wecom');
  const [name, setName] = useState('');
  const [webhook, setWebhook] = useState('');
  const [secret, setSecret] = useState('');
  const [key, setKey] = useState('');

  const reset = () => {
    setName('');
    setWebhook('');
    setSecret('');
    setKey('');
  };

  const submit = () => {
    void run(async () => {
      await api('/api/account/channels', {
        kind,
        name: name.trim() || CHANNEL_LABELS[kind],
        webhook: webhook.trim(),
        secret: secret.trim(),
        key: key.trim(),
      });
      reset();
      setOpen(false);
    });
  };

  return (
    <section className="rounded-2xl border border-line bg-white p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Bot className="h-4 w-4 text-gold" aria-hidden="true" />
          我的推送机器人
        </h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setOpen((value) => !value)}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          绑定机器人
        </Button>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
        每个用户使用自己的机器人，互不影响。每种渠道最多{' '}
        {data.limits.channelsPerKind} 个。
      </p>

      {open && (
        <div className="mt-4 space-y-3 rounded-xl border border-line bg-slate-50/80 p-4">
          <label className="block text-[11px] text-slate-500">
            渠道类型
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value as ChannelKind)}
              className="mt-1 h-9 w-full rounded-lg border border-line bg-white px-2.5 text-xs text-ink outline-none focus:border-gold"
            >
              {Object.entries(CHANNEL_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[10px] leading-relaxed text-slate-400">
              {CHANNEL_HINTS[kind]}
            </span>
          </label>

          <label className="block text-[11px] text-slate-500">
            备注名称（可选）
            <Input
              value={name}
              maxLength={20}
              onChange={(event) => setName(event.target.value)}
              placeholder={CHANNEL_LABELS[kind]}
              className="mt-1"
            />
          </label>

          {kind !== 'bark' && (
            <label className="block text-[11px] text-slate-500">
              Webhook 地址
              <Input
                value={webhook}
                onChange={(event) => setWebhook(event.target.value)}
                placeholder="https://..."
                className="mt-1"
              />
            </label>
          )}

          {(kind === 'feishu' || kind === 'dingtalk') && (
            <label className="block text-[11px] text-slate-500">
              签名密钥（可选）
              <Input
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                placeholder="机器人开启加签时填写"
                className="mt-1"
              />
            </label>
          )}

          {kind === 'bark' && (
            <label className="block text-[11px] text-slate-500">
              Bark Key
              <Input
                value={key}
                onChange={(event) => setKey(event.target.value)}
                placeholder="设备 Key 或 https://api.day.app/xxx"
                className="mt-1"
              />
            </label>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button size="sm" onClick={submit} disabled={busy}>
              保存
            </Button>
          </div>
        </div>
      )}

      {data.channels.length === 0 ? (
        <p className="mt-4 rounded-xl border border-dashed border-line px-4 py-6 text-center text-xs text-slate-400">
          还没有绑定机器人，绑定后才能收到订阅推送
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-line/70">
          {data.channels.map((channel) => (
            <ChannelRow
              key={channel.id}
              channel={channel}
              busy={busy}
              run={run}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ChannelRow({
  channel,
  busy,
  run,
}: {
  channel: UserChannel;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const test = async () => {
    if (testing || busy) return;
    setTesting(true);
    setResult(null);
    try {
      await api('/api/account/channels', { id: channel.id }, 'PUT');
      setResult('测试消息已发送');
    } catch (error) {
      setResult(error instanceof Error ? error.message : '发送失败');
    } finally {
      setTesting(false);
    }
  };

  return (
    <li className="py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p
            className={cn(
              'flex items-center gap-1.5 text-sm',
              channel.enabled ? 'text-ink' : 'text-slate-400',
            )}
          >
            <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
              {CHANNEL_LABELS[channel.kind]}
            </span>
            {channel.name}
          </p>
          <p className="mt-1 truncate font-mono text-[10px] text-slate-400">
            {channel.kind === 'bark' ? 'Key 已配置' : channel.webhook}
          </p>
          {result && (
            <p
              className={cn(
                'mt-1 text-[10px]',
                result === '测试消息已发送' ? 'text-emerald-600' : 'text-red-600',
              )}
            >
              {result}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void test()}
            disabled={testing || busy}
          >
            {testing ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Send className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            测试
          </Button>
          <ToggleButton
            active={channel.enabled}
            disabled={busy}
            onClick={() =>
              void run(() =>
                api('/api/account/channels', {
                  id: channel.id,
                  enabled: !channel.enabled,
                }, 'PATCH'),
              )
            }
          />
          <IconButton
            label="删除"
            disabled={busy}
            onClick={() => {
              if (!window.confirm(`删除机器人「${channel.name}」？`)) return;
              void run(() => api('/api/account/channels', { id: channel.id }, 'DELETE'));
            }}
          />
        </div>
      </div>
    </li>
  );
}

function DeliveriesSection({ deliveries }: { deliveries: DeliveryRecord[] }) {
  const summary = useMemo(
    () => ({
      sent: deliveries.filter((item) => item.status === 'sent').length,
      failed: deliveries.filter((item) => item.status === 'failed').length,
    }),
    [deliveries],
  );

  return (
    <section className="rounded-2xl border border-line bg-white p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink">最近推送</h2>
        <span className="text-[11px] text-slate-400">
          已送达 {summary.sent} · 失败 {summary.failed}
        </span>
      </div>

      {deliveries.length === 0 ? (
        <p className="mt-4 rounded-xl border border-dashed border-line px-4 py-6 text-center text-xs text-slate-400">
          还没有推送记录
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-line/70">
          {deliveries.map((item) => (
            <li key={item.id} className="flex items-start justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <a
                  href={item.link}
                  target="_blank"
                  rel="noreferrer"
                  className="line-clamp-1 text-xs font-medium text-ink hover:text-gold"
                >
                  {item.title}
                </a>
                <p className="mt-0.5 truncate text-[10px] text-slate-400">
                  关键词「{item.keyword}」· {item.channelName}
                  {item.sentAt ? ` · ${formatTime(item.sentAt)}` : ''}
                </p>
                {item.error && (
                  <p className="mt-0.5 line-clamp-1 text-[10px] text-red-500">
                    {item.error}
                  </p>
                )}
              </div>
              <span
                className={cn(
                  'shrink-0 rounded-full px-2 py-0.5 text-[10px]',
                  item.status === 'sent' &&
                    'bg-emerald-50 text-emerald-700',
                  item.status === 'failed' && 'bg-red-50 text-red-700',
                  item.status === 'pending' && 'bg-slate-100 text-slate-500',
                  item.status === 'digested' && 'bg-amber-50 text-amber-700',
                  item.status === 'skipped' && 'bg-slate-100 text-slate-400',
                )}
              >
                {STATUS_LABELS[item.status]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ToggleButton({
  active,
  disabled,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        'inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg border text-[10px] transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        active
          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
          : 'border-line bg-white text-slate-400',
      )}
      title={active ? '已启用' : '已暂停'}
    >
      <Check className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg border border-line bg-white text-slate-400 transition-colors hover:border-red-200 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}
