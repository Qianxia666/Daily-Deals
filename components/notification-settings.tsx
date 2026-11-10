'use client';

import { BellRing, LoaderCircle, Send } from 'lucide-react';
import type { RuntimeSettingView } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { Input } from './ui/input';

interface NotifyResult {
  kind: string;
  ok: boolean;
  text: string;
}

interface Props {
  fields: RuntimeSettingView[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  onTest: (kind: string) => void;
  busy: string | null;
  result: NotifyResult | null;
}

const CHANNELS: {
  kind: string;
  label: string;
  hint: string;
  configKey: string;
  fields: string[];
}[] = [
  {
    kind: 'wecom',
    label: '企业微信',
    hint: '群机器人 Webhook，形如 qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…',
    configKey: 'NOTIFY_WECOM_WEBHOOK',
    fields: ['NOTIFY_WECOM_ENABLED', 'NOTIFY_WECOM_WEBHOOK'],
  },
  {
    kind: 'feishu',
    label: '飞书',
    hint: '群机器人 Webhook；开启签名校验时填写密钥。留空则沿用旧版飞书告警配置。',
    configKey: 'NOTIFY_FEISHU_WEBHOOK',
    fields: [
      'NOTIFY_FEISHU_ENABLED',
      'NOTIFY_FEISHU_WEBHOOK',
      'NOTIFY_FEISHU_SECRET',
    ],
  },
  {
    kind: 'dingtalk',
    label: '钉钉',
    hint: '群机器人 Webhook；安全设置选择「加签」时填写密钥。',
    configKey: 'NOTIFY_DINGTALK_WEBHOOK',
    fields: [
      'NOTIFY_DINGTALK_ENABLED',
      'NOTIFY_DINGTALK_WEBHOOK',
      'NOTIFY_DINGTALK_SECRET',
    ],
  },
  {
    kind: 'bark',
    label: 'Bark',
    hint: 'iOS Bark 推送，填写设备 Key，或完整 https://api.day.app/… 地址。',
    configKey: 'NOTIFY_BARK_KEY',
    fields: ['NOTIFY_BARK_ENABLED', 'NOTIFY_BARK_KEY'],
  },
];

function Field({
  field,
  values,
  onChange,
}: {
  field: RuntimeSettingView;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <label className="block min-w-0 text-[11px] text-slate-500">
      <span className="flex flex-wrap items-center gap-1.5">
        {field.label}
        {field.secret && field.configured && (
          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[9px] text-emerald-700">
            已设置
          </span>
        )}
      </span>

      {field.type === 'select' ? (
        <select
          value={values[field.key] ?? ''}
          onChange={(event) => onChange(field.key, event.target.value)}
          className="mt-1 h-10 w-full rounded-xl border border-line bg-white px-3 text-sm text-ink transition-colors hover:border-slate-300 focus:border-slate-400"
        >
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
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
          value={values[field.key] ?? ''}
          placeholder={
            field.secret && field.configured
              ? '已设置，留空保持不变'
              : field.description
          }
          onChange={(event) => onChange(field.key, event.target.value)}
          className="mt-1 h-10"
        />
      )}

      <span className="mt-1 block text-[10px] leading-relaxed text-slate-400">
        {field.description}
      </span>
    </label>
  );
}

export function NotificationSettings({
  fields,
  values,
  onChange,
  onTest,
  busy,
  result,
}: Props) {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const channelKeys = new Set(CHANNELS.flatMap((channel) => channel.fields));
  const alarmFields = fields.filter((field) => !channelKeys.has(field.key));

  return (
    <div>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
        这里配置管理员系统告警（来源抓取失败等）与渠道测试。普通用户的订阅推送使用各自在账号中心绑定的机器人，不会使用这里的管理员渠道。
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {CHANNELS.map((channel) => {
          const channelFields = channel.fields
            .map((key) => byKey.get(key))
            .filter((field): field is RuntimeSettingView => Boolean(field));
          if (channelFields.length === 0) return null;

          const enabledKey = channel.fields[0];
          const enabled = (values[enabledKey] ?? 'true') === 'true';
          const configured = Boolean(byKey.get(channel.configKey)?.configured);
          const channelResult =
            result && result.kind === channel.kind ? result : null;

          return (
            <div
              key={channel.kind}
              className="rounded-xl border border-line bg-slate-50/50 p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-ink">
                    {channel.label}
                  </span>
                  <span
                    className={cn(
                      'rounded-full border px-1.5 py-0.5 text-[9px]',
                      enabled && configured
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                        : enabled
                          ? 'border-amber-200 bg-amber-50 text-amber-700'
                          : 'border-line bg-white text-slate-400',
                    )}
                  >
                    {!enabled
                      ? '已停用'
                      : configured
                        ? '已配置'
                        : '待配置'}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    value={values[enabledKey] ?? 'true'}
                    onChange={(event) =>
                      onChange(enabledKey, event.target.value)
                    }
                    className="h-8 rounded-lg border border-line bg-white px-2 text-[11px] text-ink"
                    aria-label={`${channel.label}启用状态`}
                  >
                    <option value="true">启用</option>
                    <option value="false">停用</option>
                  </select>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => onTest(channel.kind)}
                  >
                    {busy === channel.kind ? (
                      <LoaderCircle
                        className="h-3.5 w-3.5 animate-spin"
                        aria-hidden="true"
                      />
                    ) : (
                      <Send className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    测试
                  </Button>
                </div>
              </div>

              <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
                {channel.hint}
              </p>

              <div className="mt-2 space-y-2">
                {channelFields
                  .filter((field) => field.key !== enabledKey)
                  .map((field) => (
                    <Field
                      key={field.key}
                      field={field}
                      values={values}
                      onChange={onChange}
                    />
                  ))}
              </div>

              {channelResult && (
                <p
                  className={cn(
                    'mt-2 rounded-lg px-2 py-1.5 text-[10px] leading-relaxed',
                    channelResult.ok
                      ? 'bg-emerald-50 text-emerald-700'
                      : 'bg-red-50 text-red-700',
                  )}
                >
                  {channelResult.text}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {alarmFields.length > 0 && (
        <div className="mt-4 rounded-xl border border-line p-3">
          <h4 className="flex items-center gap-1.5 text-xs font-semibold text-slate-700">
            <BellRing className="h-3.5 w-3.5 text-gold" aria-hidden="true" />
            告警规则
          </h4>
          <div className="mt-2 grid gap-3 sm:grid-cols-3">
            {alarmFields.map((field) => (
              <Field
                key={field.key}
                field={field}
                values={values}
                onChange={onChange}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
