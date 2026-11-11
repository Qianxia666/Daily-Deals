export function formatUpdatedAt(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

// 固定东八区，避免服务端（UTC）与浏览器本地时区渲染不一致导致 hydration 报错。
const SHANGHAI_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function shanghaiParts(date: Date): Record<string, string> {
  const parts = SHANGHAI_FORMATTER.formatToParts(date);
  const result: Record<string, string> = {};
  for (const part of parts) result[part.type] = part.value;
  if (result.hour === '24') result.hour = '00';
  return result;
}

/** 原文发布时间：同年显示 MM-DD HH:mm，跨年补上年份。 */
export function formatPublishedAt(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  const parts = shanghaiParts(date);
  const label = `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  const currentYear = shanghaiParts(new Date()).year;

  return parts.year === currentYear ? label : `${parts.year}-${label}`;
}

export interface ExpiryInfo {
  text: string;
  urgent: boolean;
  expired: boolean;
}

export function getExpiryInfo(iso: string | null): ExpiryInfo | null {
  if (!iso) return null;
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return null;

  const date = new Date(timestamp);
  const now = new Date();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const dateLabel =
    date.getFullYear() === now.getFullYear()
      ? `${month}月${day}日`
      : `${date.getFullYear()}年${month}月${day}日`;

  if (timestamp <= Date.now()) {
    return { text: `${dateLabel} 已到期`, urgent: false, expired: true };
  }

  const urgent = timestamp - Date.now() <= 48 * 60 * 60 * 1000;
  return {
    text: urgent ? `即将到期 · ${dateLabel}` : `${dateLabel} 到期`,
    urgent,
    expired: false,
  };
}
