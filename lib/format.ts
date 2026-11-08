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
