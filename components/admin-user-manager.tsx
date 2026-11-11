'use client';

import {
  LoaderCircle,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  UserCog,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type {
  AdminUser,
  AdminUserDetail,
  ChannelKind,
  UserChannel,
} from '@/lib/types';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { CollapsibleSection } from './ui/collapsible-section';
import { Input } from './ui/input';

const KIND_LABELS: Record<ChannelKind, string> = {
  wecom: '企业微信',
  feishu: '飞书',
  dingtalk: '钉钉',
  bark: 'Bark',
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

function maskSecret(value: string): string {
  if (!value) return '未配置';
  if (value.length <= 10) return '••••••';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

async function readError(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => null)) as
    | { error?: string }
    | null;
  return payload?.error ?? `请求失败（HTTP ${response.status}）`;
}

export function AdminUserManager() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'all' | 'active' | 'disabled'>('all');
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{
    type: 'ok' | 'error';
    text: string;
  } | null>(null);

  const [detail, setDetail] = useState<AdminUserDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [emailDraft, setEmailDraft] = useState('');
  const [passwordDraft, setPasswordDraft] = useState('');
  const [newKeyword, setNewKeyword] = useState('');
  const [editingSubId, setEditingSubId] = useState<number | null>(null);
  const [editingKeyword, setEditingKeyword] = useState('');

  const pageSize = 20;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        query,
        status,
        page: String(page),
        pageSize: String(pageSize),
      });
      const response = await fetch(`/api/admin/users?${params}`, {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(await readError(response));
      const payload = (await response.json()) as {
        users: AdminUser[];
        total: number;
      };
      setUsers(payload.users);
      setTotal(payload.total);
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : '用户列表加载失败',
      });
    } finally {
      setLoading(false);
    }
  }, [page, query, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadDetail = useCallback(async (id: number) => {
    setDetailLoading(true);
    try {
      const response = await fetch(`/api/admin/users/${id}`, {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(await readError(response));
      const payload = (await response.json()) as AdminUserDetail;
      setDetail(payload);
      setEmailDraft(payload.user.email);
      setPasswordDraft('');
      setEditingSubId(null);
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : '用户详情加载失败',
      });
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const patchUser = async (body: Record<string, unknown>, busyKey: string) => {
    if (!detail || busy) return;
    setBusy(busyKey);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/users/${detail.user.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await readError(response));
      const payload = (await response.json()) as AdminUserDetail;
      setDetail(payload);
      setEmailDraft(payload.user.email);
      setPasswordDraft('');
      setMessage({ type: 'ok', text: '已保存' });
      await load();
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : '保存失败',
      });
    } finally {
      setBusy(null);
    }
  };

  const removeUser = async () => {
    if (!detail || busy) return;
    if (
      !window.confirm(
        `确定删除 ${detail.user.email}？其订阅、机器人渠道和推送记录都会被删除，且无法恢复。`,
      )
    ) {
      return;
    }
    setBusy('delete');
    try {
      const response = await fetch(`/api/admin/users/${detail.user.id}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error(await readError(response));
      setDetail(null);
      setMessage({ type: 'ok', text: '用户已删除' });
      await load();
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : '删除失败',
      });
    } finally {
      setBusy(null);
    }
  };

  const mutateSubscriptions = async (
    method: 'POST' | 'PATCH' | 'DELETE',
    body: Record<string, unknown>,
    busyKey: string,
  ) => {
    if (!detail || busy) return;
    setBusy(busyKey);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/admin/users/${detail.user.id}/subscriptions`,
        {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!response.ok) throw new Error(await readError(response));
      const payload = (await response.json()) as {
        subscriptions: AdminUserDetail['subscriptions'];
      };
      setDetail((previous) =>
        previous ? { ...previous, subscriptions: payload.subscriptions } : null,
      );
      setNewKeyword('');
      setEditingSubId(null);
      await load();
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : '订阅操作失败',
      });
    } finally {
      setBusy(null);
    }
  };

  const toggleChannel = async (channel: UserChannel) => {
    if (!detail || busy) return;
    setBusy(`channel-${channel.id}`);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/admin/users/${detail.user.id}/channels`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channelId: channel.id, enabled: !channel.enabled }),
        },
      );
      if (!response.ok) throw new Error(await readError(response));
      await loadDetail(detail.user.id);
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : '渠道操作失败',
      });
    } finally {
      setBusy(null);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <CollapsibleSection
      id="users"
      title={
        <span className="flex items-center gap-2">
          <UserCog className="h-4 w-4 text-slate-500" aria-hidden="true" />
          注册用户管理
        </span>
      }
      description="可查看和修改用户邮箱、重置密码、管理订阅关键词与推送渠道。密码为加盐哈希，无法查看原密码。"
      actions={
        <span className="text-[11px] text-slate-400">共 {total} 个账号</span>
      }
      defaultOpen
    >
      <div className="mt-3 flex flex-wrap gap-2">
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
            aria-hidden="true"
          />
          <Input
            value={query}
            placeholder="按邮箱搜索"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                setPage(1);
                void load();
              }
            }}
            className="h-10 pl-9"
          />
        </div>
        <select
          value={status}
          onChange={(event) => {
            setStatus(event.target.value as typeof status);
            setPage(1);
          }}
          className="h-10 rounded-xl border border-line bg-white px-3 text-xs text-ink"
        >
          <option value="all">全部状态</option>
          <option value="active">正常</option>
          <option value="disabled">已禁用</option>
        </select>
        <Button
          variant="outline"
          className="h-10"
          onClick={() => {
            setPage(1);
            void load();
          }}
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          刷新
        </Button>
      </div>

      {message && !detail && (
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
      ) : users.length === 0 ? (
        <p className="mt-3 rounded-xl border border-dashed border-line px-4 py-6 text-center text-xs text-slate-400">
          没有符合条件的用户
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-line/70">
          {users.map((user) => (
            <li
              key={user.id}
              className="flex flex-wrap items-center justify-between gap-3 py-2.5"
            >
              <div className="min-w-0">
                <p
                  className={cn(
                    'truncate text-xs font-medium',
                    user.disabled ? 'text-slate-400' : 'text-ink',
                  )}
                >
                  {user.email}
                  {user.disabled && (
                    <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] text-slate-500">
                      已禁用
                    </span>
                  )}
                </p>
                <p className="mt-0.5 text-[10px] text-slate-400">
                  注册 {formatDateTime(user.createdAt)} · 最近登录{' '}
                  {formatDateTime(user.lastLoginAt)} · {user.subscriptionCount} 个订阅 ·{' '}
                  {user.channelCount} 个机器人 · 今日 AI {user.aiQuotaUsed} 次
                  {user.inviteCode ? ` · 邀请码 ${user.inviteCode}` : ''}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={detailLoading}
                onClick={() => void loadDetail(user.id)}
              >
                管理
              </Button>
            </li>
          ))}
        </ul>
      )}

      {total > pageSize && (
        <div className="mt-3 flex items-center justify-between text-[11px] text-slate-500">
          <span>
            第 {page} / {totalPages} 页
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((previous) => Math.max(1, previous - 1))}
            >
              上一页
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() =>
                setPage((previous) => Math.min(totalPages, previous + 1))
              }
            >
              下一页
            </Button>
          </div>
        </div>
      )}

      {(detail || detailLoading) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3">
          <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-4 shadow-xl sm:p-5">
            {detailLoading || !detail ? (
              <p className="py-10 text-center text-xs text-slate-400">
                加载用户详情…
              </p>
            ) : (
              <>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-ink">
                      {detail.user.email}
                    </h3>
                    <p className="mt-0.5 text-[10px] text-slate-400">
                      注册 {formatDateTime(detail.user.createdAt)} · 最近登录{' '}
                      {formatDateTime(detail.user.lastLoginAt)} · 今日 AI{' '}
                      {detail.user.aiQuotaUsed}/{detail.aiQuotaLimit || '不限'} 次
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setDetail(null);
                      setMessage(null);
                    }}
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </Button>
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

                <div className="mt-4 rounded-xl border border-line p-3">
                  <h4 className="text-xs font-semibold text-slate-700">
                    账号设置
                  </h4>
                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    <label className="min-w-0 flex-1 text-[11px] text-slate-500">
                      邮箱
                      <Input
                        value={emailDraft}
                        onChange={(event) => setEmailDraft(event.target.value)}
                        className="mt-1 h-10"
                      />
                    </label>
                    <Button
                      variant="outline"
                      className="h-10"
                      disabled={busy !== null}
                      onClick={() =>
                        void patchUser({ email: emailDraft }, 'email')
                      }
                    >
                      {busy === 'email' && (
                        <LoaderCircle
                          className="h-3.5 w-3.5 animate-spin"
                          aria-hidden="true"
                        />
                      )}
                      保存邮箱
                    </Button>
                  </div>

                  <div className="mt-3 flex flex-wrap items-end gap-2">
                    <label className="min-w-0 flex-1 text-[11px] text-slate-500">
                      重置密码
                      <Input
                        value={passwordDraft}
                        placeholder="6–72 位，留空不修改"
                        onChange={(event) =>
                          setPasswordDraft(event.target.value)
                        }
                        className="mt-1 h-10"
                      />
                    </label>
                    <Button
                      variant="ghost"
                      className="h-10"
                      onClick={() =>
                        setPasswordDraft(
                          crypto.randomUUID().replace(/-/g, '').slice(0, 10),
                        )
                      }
                    >
                      随机生成
                    </Button>
                    <Button
                      className="h-10"
                      disabled={busy !== null || passwordDraft.length === 0}
                      onClick={() =>
                        void patchUser({ password: passwordDraft }, 'password')
                      }
                    >
                      {busy === 'password' && (
                        <LoaderCircle
                          className="h-3.5 w-3.5 animate-spin"
                          aria-hidden="true"
                        />
                      )}
                      重置密码
                    </Button>
                  </div>
                  <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
                    重置密码后该用户所有登录会话立即失效，请把新密码单独告知用户。
                  </p>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() =>
                        void patchUser(
                          { disabled: !detail.user.disabled },
                          'disabled',
                        )
                      }
                    >
                      {detail.user.disabled ? '启用账号' : '禁用账号'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => void removeUser()}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      删除账号
                    </Button>
                  </div>
                </div>

                <div className="mt-3 rounded-xl border border-line p-3">
                  <h4 className="text-xs font-semibold text-slate-700">
                    订阅关键词（{detail.subscriptions.length}）
                  </h4>

                  <div className="mt-2 flex gap-2">
                    <Input
                      value={newKeyword}
                      placeholder="新增关键词，至少 2 个字符"
                      onChange={(event) => setNewKeyword(event.target.value)}
                      className="h-9"
                    />
                    <Button
                      size="sm"
                      className="h-9"
                      disabled={busy !== null || newKeyword.trim().length < 2}
                      onClick={() =>
                        void mutateSubscriptions(
                          'POST',
                          { keyword: newKeyword },
                          'sub-add',
                        )
                      }
                    >
                      添加
                    </Button>
                  </div>

                  {detail.subscriptions.length === 0 ? (
                    <p className="mt-2 text-[11px] text-slate-400">
                      还没有订阅关键词
                    </p>
                  ) : (
                    <ul className="mt-2 divide-y divide-line/70">
                      {detail.subscriptions.map((subscription) => (
                        <li
                          key={subscription.id}
                          className="flex flex-wrap items-center justify-between gap-2 py-2"
                        >
                          {editingSubId === subscription.id ? (
                            <div className="flex min-w-0 flex-1 gap-2">
                              <Input
                                value={editingKeyword}
                                onChange={(event) =>
                                  setEditingKeyword(event.target.value)
                                }
                                className="h-9"
                              />
                              <Button
                                size="sm"
                                className="h-9"
                                disabled={busy !== null}
                                onClick={() =>
                                  void mutateSubscriptions(
                                    'PATCH',
                                    {
                                      subscriptionId: subscription.id,
                                      keyword: editingKeyword,
                                    },
                                    'sub-edit',
                                  )
                                }
                              >
                                保存
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-9"
                                onClick={() => setEditingSubId(null)}
                              >
                                取消
                              </Button>
                            </div>
                          ) : (
                            <>
                              <span
                                className={cn(
                                  'min-w-0 truncate text-xs',
                                  subscription.enabled
                                    ? 'text-ink'
                                    : 'text-slate-400 line-through',
                                )}
                              >
                                {subscription.keyword}
                              </span>
                              <div className="flex items-center gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => {
                                    setEditingSubId(subscription.id);
                                    setEditingKeyword(subscription.keyword);
                                  }}
                                >
                                  <Pencil
                                    className="h-3.5 w-3.5"
                                    aria-hidden="true"
                                  />
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={busy !== null}
                                  onClick={() =>
                                    void mutateSubscriptions(
                                      'PATCH',
                                      {
                                        subscriptionId: subscription.id,
                                        enabled: !subscription.enabled,
                                      },
                                      `sub-${subscription.id}`,
                                    )
                                  }
                                >
                                  {subscription.enabled ? '暂停' : '启用'}
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={busy !== null}
                                  onClick={() =>
                                    void mutateSubscriptions(
                                      'DELETE',
                                      { subscriptionId: subscription.id },
                                      `sub-${subscription.id}`,
                                    )
                                  }
                                >
                                  <Trash2
                                    className="h-3.5 w-3.5"
                                    aria-hidden="true"
                                  />
                                </Button>
                              </div>
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="mt-3 rounded-xl border border-line p-3">
                  <h4 className="text-xs font-semibold text-slate-700">
                    推送渠道（{detail.channels.length}）
                  </h4>
                  {detail.channels.length === 0 ? (
                    <p className="mt-2 text-[11px] text-slate-400">
                      还没有绑定机器人
                    </p>
                  ) : (
                    <ul className="mt-2 divide-y divide-line/70">
                      {detail.channels.map((channel) => (
                        <li
                          key={channel.id}
                          className="flex flex-wrap items-center justify-between gap-2 py-2"
                        >
                          <div className="min-w-0">
                            <p className="text-xs text-ink">
                              {KIND_LABELS[channel.kind]} · {channel.name}
                              {!channel.enabled && (
                                <span className="ml-1.5 text-[9px] text-slate-400">
                                  已停用
                                </span>
                              )}
                            </p>
                            <p className="mt-0.5 truncate text-[10px] text-slate-400">
                              {maskSecret(channel.webhook)}
                            </p>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy !== null}
                            onClick={() => void toggleChannel(channel)}
                          >
                            {channel.enabled ? '停用' : '启用'}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
                    Webhook 只脱敏展示，管理员不能查看完整密钥。
                  </p>
                </div>

                <div className="mt-3 rounded-xl border border-line p-3">
                  <h4 className="text-xs font-semibold text-slate-700">
                    最近推送
                  </h4>
                  {detail.deliveries.length === 0 ? (
                    <p className="mt-2 text-[11px] text-slate-400">
                      暂无推送记录
                    </p>
                  ) : (
                    <ul className="mt-2 divide-y divide-line/70">
                      {detail.deliveries.map((delivery) => (
                        <li key={delivery.id} className="py-1.5">
                          <p className="truncate text-[11px] text-ink">
                            {delivery.title}
                          </p>
                          <p className="text-[10px] text-slate-400">
                            {delivery.keyword} · {delivery.channelName} ·{' '}
                            {delivery.status === 'sent'
                              ? '已发送'
                              : delivery.status === 'failed'
                                ? '发送失败'
                                : delivery.status === 'digested'
                                  ? '已合并到摘要'
                                  : delivery.status === 'skipped'
                                    ? '已跳过'
                                    : '待发送'}{' '}
                            · {formatDateTime(delivery.sentAt ?? delivery.createdAt)}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </CollapsibleSection>
  );
}
