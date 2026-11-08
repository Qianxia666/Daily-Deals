import { NextResponse, type NextRequest } from 'next/server';
import { isAdmin } from '@/lib/admin';
import {
  getSource,
  listSources,
  saveAnnouncement,
  saveSourceSettings,
  type SourceSettingsInput,
} from '@/lib/db';
import {
  getAdminPayload,
  saveRuntimeSettings,
} from '@/lib/runtime-settings';
import type { SourceKind } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const KINDS: SourceKind[] = ['rss', 'epic', 'linuxdo', 'xianbao'];

interface SourceBody {
  id?: unknown;
  hidden?: unknown;
  refreshMinutes?: unknown;
  name?: unknown;
  url?: unknown;
  kind?: unknown;
}

interface SettingsBody {
  announcement?: { enabled?: unknown; text?: unknown };
  sources?: SourceBody[];
  runtimeEnv?: Record<string, unknown>;
}

function normalizeRefresh(value: unknown): number | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  const rounded = Math.round(parsed);
  if (rounded < 5 || rounded > 1440) return undefined;
  return rounded;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: '未登录' }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as
    | SettingsBody
    | null;

  if (!body) {
    return NextResponse.json({ error: '请求格式错误' }, { status: 400 });
  }

  if (body.announcement) {
    const enabled = body.announcement.enabled === true;
    const text =
      typeof body.announcement.text === 'string'
        ? body.announcement.text
        : '';
    saveAnnouncement(enabled, text);
  }

  if (Array.isArray(body.sources)) {
    const existing = new Set(listSources().map((source) => source.id));
    const seen = new Set<string>();
    const cleaned: SourceSettingsInput[] = [];

    for (const item of body.sources) {
      const id = typeof item?.id === 'string' ? item.id : '';
      if (!existing.has(id) || seen.has(id)) continue;
      seen.add(id);

      const refreshMinutes = normalizeRefresh(item.refreshMinutes);
      if (refreshMinutes === undefined) {
        return NextResponse.json(
          { error: '刷新间隔需为 5–1440 分钟，或留空使用全局间隔' },
          { status: 400 },
        );
      }

      const stored = getSource(id)!;
      const name =
        typeof item.name === 'string' ? item.name.trim() : undefined;
      if (name !== undefined && (name.length < 1 || name.length > 30)) {
        return NextResponse.json(
          { error: '来源名称需为 1–30 个字符' },
          { status: 400 },
        );
      }

      const url = typeof item.url === 'string' ? item.url.trim() : undefined;
      if (url !== undefined && !isHttpUrl(url)) {
        return NextResponse.json(
          { error: '来源链接必须是 http/https 地址' },
          { status: 400 },
        );
      }

      const kind =
        typeof item.kind === 'string' &&
        KINDS.includes(item.kind as SourceKind)
          ? (item.kind as SourceKind)
          : undefined;

      if (
        kind &&
        stored.builtin &&
        (stored.kind === 'linuxdo' || stored.kind === 'xianbao') &&
        kind !== stored.kind
      ) {
        return NextResponse.json(
          { error: '该内置来源使用专用解析器，不能修改类型' },
          { status: 400 },
        );
      }

      cleaned.push({
        id,
        hidden: item.hidden === true,
        refreshMinutes,
        name,
        url,
        kind,
      });
    }

    if (cleaned.length !== existing.size) {
      return NextResponse.json(
        { error: '来源配置不完整，请刷新后台后重试' },
        { status: 400 },
      );
    }

    saveSourceSettings(cleaned);
  }

  if (body.runtimeEnv && typeof body.runtimeEnv === 'object') {
    const error = saveRuntimeSettings(body.runtimeEnv);
    if (error) {
      return NextResponse.json({ error }, { status: 400 });
    }
  }

  return NextResponse.json(getAdminPayload());
}
