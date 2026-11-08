import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { BUILTIN_SOURCES } from './sources';
import type { RawDeal } from './fetchers/types';
import type {
  AdminBaseData,
  AdminSource,
  Announcement,
  Category,
  DealItem,
  DealsResponse,
  SourceKind,
  SourceStatus,
} from './types';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS deals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  category TEXT NOT NULL,
  expires_at TEXT,
  published_at TEXT,
  is_new INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ai_title TEXT,
  ai_summary TEXT,
  ai_value TEXT,
  ai_action TEXT,
  ai_model TEXT,
  ai_at TEXT,
  ai_attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_deals_source ON deals(source);
CREATE INDEX IF NOT EXISTS idx_deals_expires ON deals(expires_at);
CREATE INDEX IF NOT EXISTS idx_deals_published ON deals(published_at);

CREATE TABLE IF NOT EXISTS fetch_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fetched_at TEXT NOT NULL,
  statuses TEXT NOT NULL,
  new_count INTEGER NOT NULL DEFAULT 0,
  active_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS source_status (
  source TEXT PRIMARY KEY,
  ok INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_settings (
  source TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'rss',
  sort_order INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  builtin INTEGER NOT NULL DEFAULT 0,
  refresh_minutes INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

interface DealRow {
  id: number;
  link: string;
  title: string;
  description: string;
  source: string;
  category: string;
  expires_at: string | null;
  published_at: string | null;
  is_new: number;
  first_seen_at: string;
  last_seen_at: string;
  ai_title: string | null;
  ai_summary: string | null;
  ai_value: string | null;
  ai_action: string | null;
  ai_model: string | null;
  ai_at: string | null;
  claimed: number;
  favorite: number;
}

interface ExistingDealRow {
  id: number;
  title: string;
  description: string;
  ai_title: string | null;
  ai_summary: string | null;
  ai_value: string | null;
  ai_action: string | null;
  ai_model: string | null;
  ai_at: string | null;
}

export interface AiPendingDeal {
  id: number;
  title: string;
  description: string;
  source: string;
  category: Category;
}

export interface AiEnrichment {
  title: string;
  summary: string;
  value: string;
  action: string;
}

interface StatusRow {
  source: string;
  ok: number;
  count: number;
  error: string | null;
  fetched_at: string;
}

interface SourceRow {
  id: string;
  name: string;
  url: string;
  kind: string;
  sort_order: number;
  hidden: number;
  enabled: number;
  builtin: number;
  refresh_minutes: number | null;
}

export interface StoredSource {
  id: string;
  name: string;
  url: string;
  kind: SourceKind;
  order: number;
  hidden: boolean;
  refreshMinutes: number | null;
  builtin: boolean;
}

export interface SourceStatusRecord {
  source: string;
  ok: boolean;
  count: number;
  error: string | null;
  fetchedAt: string;
}

interface SourceCountRow {
  source: string;
  count: number;
}

export interface SourceRunStatus {
  source: string;
  ok: boolean;
  count: number;
  error: string | null;
}

export interface SourceSettingsInput {
  id: string;
  hidden: boolean;
  refreshMinutes: number | null;
  name?: string;
  url?: string;
  kind?: SourceKind;
}

export interface NewSourceInput {
  id: string;
  name: string;
  url: string;
  kind: SourceKind;
  refreshMinutes: number | null;
  hidden: boolean;
}

export type DealsSnapshot = Omit<
  DealsResponse,
  'fetching' | 'searchWindows' | 'site'
>;

const globalForDb = globalThis as typeof globalThis & {
  __dailyDealsDb?: Database.Database;
};

function getDb(): Database.Database {
  if (globalForDb.__dailyDealsDb) return globalForDb.__dailyDealsDb;

  const databasePath =
    process.env.DATABASE_PATH?.trim() || path.join('data', 'app.db');
  const absolutePath = path.resolve(databasePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });

  const db = new Database(absolutePath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  ensureSources(db);

  globalForDb.__dailyDealsDb = db;
  return db;
}

/** 兼容旧数据库：为已有的 deals 表补充 AI 摘要字段。 */
function migrate(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(deals)').all() as {
    name: string;
  }[];
  const existing = new Set(columns.map((column) => column.name));

  const additions: [string, string][] = [
    ['ai_title', 'TEXT'],
    ['ai_summary', 'TEXT'],
    ['ai_value', 'TEXT'],
    ['ai_action', 'TEXT'],
    ['ai_model', 'TEXT'],
    ['ai_at', 'TEXT'],
    ['ai_attempts', 'INTEGER NOT NULL DEFAULT 0'],
  ];

  for (const [name, type] of additions) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE deals ADD COLUMN ${name} ${type}`);
    }
  }
}

/**
 * 首次启动时写入内置来源；老版本 source_settings 中的顺序/隐藏状态会一并迁移。
 * 已存在的来源不会被覆盖，管理员在后台的修改得以保留。
 */
function ensureSources(db: Database.Database): void {
  const existingRows = db
    .prepare('SELECT id, sort_order FROM sources')
    .all() as { id: string; sort_order: number }[];
  const existing = new Set(existingRows.map((row) => row.id));
  const hasSources = existingRows.length > 0;

  const legacyRows = db
    .prepare('SELECT source, sort_order, hidden FROM source_settings')
    .all() as { source: string; sort_order: number; hidden: number }[];
  const legacy = new Map(legacyRows.map((row) => [row.source, row]));

  let maxOrder = existingRows.reduce(
    (max, row) => Math.max(max, row.sort_order),
    -1,
  );

  const insert = db.prepare(`
    INSERT OR IGNORE INTO sources (
      id, name, url, kind, sort_order, hidden, enabled, builtin,
      refresh_minutes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, NULL, ?, ?)
  `);

  const now = new Date().toISOString();
  const seed = db.transaction(() => {
    for (const source of BUILTIN_SOURCES) {
      if (existing.has(source.id)) continue;

      const old = legacy.get(source.id);
      let order: number;
      if (!hasSources && old) {
        order = old.sort_order;
      } else {
        maxOrder += 1;
        order = maxOrder;
      }
      maxOrder = Math.max(maxOrder, order);

      insert.run(
        source.id,
        source.name,
        source.url,
        source.kind,
        order,
        old?.hidden ? 1 : 0,
        now,
        now,
      );
    }
  });

  seed();
}

function toStoredSource(row: SourceRow): StoredSource {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    kind: row.kind as SourceKind,
    order: row.sort_order,
    hidden: row.hidden === 1,
    refreshMinutes: row.refresh_minutes,
    builtin: row.builtin === 1,
  };
}

/** 返回所有启用的来源（包含首页隐藏的来源，隐藏只影响展示）。 */
export function listSources(): StoredSource[] {
  const rows = getDb()
    .prepare(
      `SELECT id, name, url, kind, sort_order, hidden, enabled, builtin, refresh_minutes
       FROM sources WHERE enabled = 1
       ORDER BY sort_order ASC, id ASC`,
    )
    .all() as SourceRow[];
  return rows.map(toStoredSource);
}

export function getSource(id: string): StoredSource | null {
  const row = getDb()
    .prepare(
      `SELECT id, name, url, kind, sort_order, hidden, enabled, builtin, refresh_minutes
       FROM sources WHERE id = ?`,
    )
    .get(id) as SourceRow | undefined;
  return row ? toStoredSource(row) : null;
}

/** 新增自定义来源；id 已存在时返回 null。 */
export function createSource(input: NewSourceInput): StoredSource | null {
  const db = getDb();
  if (getSource(input.id)) return null;

  const maxOrder = db
    .prepare('SELECT MAX(sort_order) AS value FROM sources')
    .get() as { value: number | null };
  const order = (maxOrder.value ?? -1) + 1;
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO sources (
       id, name, url, kind, sort_order, hidden, enabled, builtin,
       refresh_minutes, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)`,
  ).run(
    input.id,
    input.name,
    input.url,
    input.kind,
    order,
    input.hidden ? 1 : 0,
    input.refreshMinutes,
    now,
    now,
  );

  return getSource(input.id);
}

/** 删除自定义来源及其已入库条目。 */
export function deleteSource(id: string): boolean {
  const db = getDb();
  if (!getSource(id)) return false;

  const remove = db.transaction(() => {
    db.prepare('DELETE FROM deals WHERE source = ?').run(id);
    db.prepare('DELETE FROM source_status WHERE source = ?').run(id);
    db.prepare('DELETE FROM source_settings WHERE source = ?').run(id);
    db.prepare('DELETE FROM sources WHERE id = ?').run(id);
  });

  remove();
  return true;
}

/** 每轮开始时清空指定来源的新增标记；不传来源时清空全部。 */
export function resetNewFlags(sourceIds?: string[]): void {
  if (sourceIds && sourceIds.length === 0) return;

  if (!sourceIds) {
    getDb().prepare('UPDATE deals SET is_new = 0').run();
    return;
  }

  const placeholders = sourceIds.map(() => '?').join(', ');
  getDb()
    .prepare(`UPDATE deals SET is_new = 0 WHERE source IN (${placeholders})`)
    .run(...sourceIds);
}

/** 按原文链接去重写入；仅首次出现的链接标记为本轮新增。 */
export function upsertDeals(deals: RawDeal[]): number {
  const db = getDb();
  const now = new Date().toISOString();

  const findExisting = db.prepare(
    `SELECT id, title, description, ai_title, ai_summary, ai_value, ai_action, ai_model, ai_at
     FROM deals WHERE link = ?`,
  );
  const updateExisting = db.prepare(`
    UPDATE deals
    SET title = ?,
        description = ?,
        category = ?,
        expires_at = COALESCE(?, expires_at),
        published_at = COALESCE(?, published_at),
        last_seen_at = ?,
        ai_title = ?,
        ai_summary = ?,
        ai_value = ?,
        ai_action = ?,
        ai_model = ?,
        ai_at = ?
    WHERE link = ?
  `);
  const insertDeal = db.prepare(`
    INSERT INTO deals (
      link, title, description, source, category,
      expires_at, published_at, is_new, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(link) DO NOTHING
  `);

  const write = db.transaction((items: RawDeal[]) => {
    let inserted = 0;

    for (const item of items) {
      const existing = findExisting.get(item.link) as
        | ExistingDealRow
        | undefined;

      if (existing) {
        const nextDescription = item.description || existing.description;
        const contentChanged =
          item.title !== existing.title ||
          nextDescription !== existing.description;

        updateExisting.run(
          item.title,
          nextDescription,
          item.category,
          item.expiresAt,
          item.publishedAt,
          now,
          contentChanged ? null : existing.ai_title,
          contentChanged ? null : existing.ai_summary,
          contentChanged ? null : existing.ai_value,
          contentChanged ? null : existing.ai_action,
          contentChanged ? null : existing.ai_model,
          contentChanged ? null : existing.ai_at,
          item.link,
        );
        continue;
      }

      const result = insertDeal.run(
        item.link,
        item.title,
        item.description,
        item.source,
        item.category,
        item.expiresAt,
        item.publishedAt,
        now,
        now,
      );
      inserted += result.changes;
    }

    return inserted;
  });

  return write(deals);
}

/** 数据保留天数，默认 30 天，后台可调。 */
export function getDataRetentionDays(): number {
  const raw = getRuntimeEnvRaw('DATA_RETENTION_DAYS');
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 30;
  return Math.min(Math.max(Math.round(value), 1), 365);
}

/** 管理员是否开启 AI 搜索，默认开启。 */
export function getAiSearchEnabled(): boolean {
  const raw = getRuntimeEnvRaw('AI_SEARCH_ENABLED');
  if (raw === null || raw.trim() === '') return true;
  return raw.trim() !== 'false';
}

/** 清理已过期条目与超过保留天数的条目。 */
export function pruneDeals(): number {
  const now = new Date().toISOString();
  const cutoff = new Date(
    Date.now() - getDataRetentionDays() * 24 * 60 * 60 * 1000,
  ).toISOString();

  const result = getDb()
    .prepare(
      `DELETE FROM deals
       WHERE (expires_at IS NOT NULL AND expires_at <= ?)
          OR first_seen_at < ?`,
    )
    .run(now, cutoff);

  return result.changes;
}

/** 记录本轮各来源状态与统计信息。 */
export function saveFetchRun(
  statuses: SourceRunStatus[],
  fetchedAt: string,
): void {
  const db = getDb();

  const save = db.transaction(() => {
    const upsertStatus = db.prepare(`
      INSERT INTO source_status (source, ok, count, error, fetched_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source) DO UPDATE SET
        ok = excluded.ok,
        count = excluded.count,
        error = excluded.error,
        fetched_at = excluded.fetched_at
    `);

    for (const status of statuses) {
      upsertStatus.run(
        status.source,
        status.ok ? 1 : 0,
        status.count,
        status.error,
        fetchedAt,
      );
    }

    const active = db
      .prepare(
        `SELECT COUNT(*) AS count FROM deals
         WHERE expires_at IS NULL OR expires_at > ?`,
      )
      .get(fetchedAt) as { count: number };

    const fresh = db
      .prepare(
        `SELECT COUNT(*) AS count FROM deals
         WHERE is_new = 1 AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .get(fetchedAt) as { count: number };

    db.prepare(
      `INSERT INTO fetch_runs (fetched_at, statuses, new_count, active_count)
       VALUES (?, ?, ?, ?)`,
    ).run(
      fetchedAt,
      JSON.stringify(statuses),
      fresh.count,
      active.count,
    );
  });

  save();
}

export function getLastFetchedAt(): string | null {
  const row = getDb()
    .prepare('SELECT fetched_at FROM fetch_runs ORDER BY id DESC LIMIT 1')
    .get() as { fetched_at: string } | undefined;
  return row?.fetched_at ?? null;
}

/** 各来源最近一次抓取结果，供调度器判断是否到期。 */
export function listSourceStatus(): SourceStatusRecord[] {
  const rows = getDb()
    .prepare('SELECT source, ok, count, error, fetched_at FROM source_status')
    .all() as StatusRow[];

  return rows.map((row) => ({
    source: row.source,
    ok: row.ok === 1,
    count: row.count,
    error: row.error,
    fetchedAt: row.fetched_at,
  }));
}

/** 汇总页面所需的在架条目、可见来源与统计。 */
export function getDealsSnapshot(): DealsSnapshot {
  const db = getDb();
  const now = new Date().toISOString();
  const retentionCutoff = new Date(
    Date.now() - getDataRetentionDays() * 24 * 60 * 60 * 1000,
  ).toISOString();

  const lastRun = db
    .prepare('SELECT fetched_at FROM fetch_runs ORDER BY id DESC LIMIT 1')
    .get() as { fetched_at: string } | undefined;

  const statusRows = db
    .prepare(
      'SELECT source, ok, count, error, fetched_at FROM source_status',
    )
    .all() as StatusRow[];

  const countRows = db
    .prepare(
      `SELECT source, COUNT(*) AS count FROM deals
       WHERE (expires_at IS NULL OR expires_at > ?)
         AND first_seen_at >= ?
       GROUP BY source`,
    )
    .all(now, retentionCutoff) as SourceCountRow[];

  const rows = db
    .prepare(
      `SELECT d.*,
              0 AS claimed,
              0 AS favorite
       FROM deals d
       WHERE (d.expires_at IS NULL OR d.expires_at > ?)
         AND d.first_seen_at >= ?
       ORDER BY d.is_new DESC,
                COALESCE(d.published_at, d.first_seen_at) DESC,
                d.id DESC`,
    )
    .all(now, retentionCutoff) as DealRow[];

  const stored = listSources();
  const nameMap = new Map(stored.map((source) => [source.id, source.name]));
  const visible = stored.filter((source) => !source.hidden);
  const visibleIds = new Set(visible.map((source) => source.id));

  const items: DealItem[] = rows
    .filter((row) => visibleIds.has(row.source))
    .map((row) => ({
      id: row.id,
      title: row.title,
      link: row.link,
      description: row.description,
      source: row.source,
      sourceName: nameMap.get(row.source) ?? row.source,
      category: row.category as Category,
      expiresAt: row.expires_at,
      publishedAt: row.published_at,
      firstSeenAt: row.first_seen_at,
      isNew: row.is_new === 1,
      claimed: row.claimed === 1,
      favorite: row.favorite === 1,
      aiTitle: row.ai_title,
      aiSummary: row.ai_summary,
      aiValue: row.ai_value,
      aiAction: row.ai_action,
    }));

  const statusMap = new Map(statusRows.map((row) => [row.source, row]));
  const countMap = new Map(countRows.map((row) => [row.source, row.count]));

  const sources: SourceStatus[] = visible.map((source) => {
    const status = statusMap.get(source.id);
    return {
      id: source.id,
      name: source.name,
      ok: status ? status.ok === 1 : null,
      count: countMap.get(source.id) ?? 0,
      error: status?.error ?? null,
    };
  });

  return {
    fetchedAt: lastRun?.fetched_at ?? null,
    sources,
    stats: {
      activeCount: items.length,
      newCount: items.filter((item) => item.isNew).length,
    },
    announcement: getAnnouncement(),
    aiSearchEnabled: getAiSearchEnabled(),
    items,
  };
}

interface SettingRow {
  value: string;
}

export function getSetting(key: string): string | null {
  const row = getDb()
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(key) as SettingRow | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
    )
    .run(key, value, new Date().toISOString());
}

/**
 * 读取运行时配置：优先使用管理后台保存到 settings 的值，
 * 其次回退到 .env / 环境变量，最后返回 null 表示都未配置。
 * 网页配置始终优先，.env 作为首次部署或未在后台修改时的默认值。
 */
export function getRuntimeEnvRaw(key: string): string | null {
  const stored = getSetting(`env:${key}`);
  if (stored !== null && stored.trim() !== '') return stored;

  const env = process.env[key];
  if (env !== undefined && env.trim() !== '') return env;

  return null;
}

export function getAnnouncement(): Announcement {
  return {
    enabled: getSetting('announcement_enabled') === '1',
    text: getSetting('announcement_text') ?? '',
  };
}

export function saveAnnouncement(enabled: boolean, text: string): void {
  setSetting('announcement_enabled', enabled ? '1' : '0');
  setSetting('announcement_text', text.trim().slice(0, 500));
}

/** 按后台配置更新来源顺序、显示状态、地址与独立刷新频率。 */
export function saveSourceSettings(items: SourceSettingsInput[]): void {
  const db = getDb();
  const update = db.prepare(`
    UPDATE sources
    SET sort_order = ?,
        hidden = ?,
        refresh_minutes = ?,
        name = COALESCE(?, name),
        url = COALESCE(?, url),
        kind = COALESCE(?, kind),
        updated_at = ?
    WHERE id = ?
  `);
  const now = new Date().toISOString();

  const write = db.transaction(() => {
    items.forEach((item, index) => {
      update.run(
        index,
        item.hidden ? 1 : 0,
        item.refreshMinutes,
        item.name ?? null,
        item.url ?? null,
        item.kind ?? null,
        now,
        item.id,
      );
    });
  });

  write();
}

/** 管理后台所需的基础数据（来源状态与公告）。 */
export function getAdminData(): AdminBaseData {
  const db = getDb();
  const now = new Date().toISOString();
  const retentionCutoff = new Date(
    Date.now() - getDataRetentionDays() * 24 * 60 * 60 * 1000,
  ).toISOString();

  const lastRun = db
    .prepare('SELECT fetched_at FROM fetch_runs ORDER BY id DESC LIMIT 1')
    .get() as { fetched_at: string } | undefined;

  const statusRows = db
    .prepare(
      'SELECT source, ok, count, error, fetched_at FROM source_status',
    )
    .all() as StatusRow[];

  const countRows = db
    .prepare(
      `SELECT source, COUNT(*) AS count FROM deals
       WHERE (expires_at IS NULL OR expires_at > ?)
         AND first_seen_at >= ?
       GROUP BY source`,
    )
    .all(now, retentionCutoff) as SourceCountRow[];

  const statusMap = new Map(statusRows.map((row) => [row.source, row]));
  const countMap = new Map(countRows.map((row) => [row.source, row.count]));

  const sources: AdminSource[] = listSources().map((source) => {
    const status = statusMap.get(source.id);
    return {
      id: source.id,
      name: source.name,
      ok: status ? status.ok === 1 : null,
      count: status?.count ?? 0,
      error: status?.error ?? null,
      fetchedAt: status?.fetched_at ?? null,
      order: source.order,
      hidden: source.hidden,
      url: source.url,
      kind: source.kind,
      refreshMinutes: source.refreshMinutes,
      activeCount: countMap.get(source.id) ?? 0,
      builtin: source.builtin,
    };
  });

  return {
    fetchedAt: lastRun?.fetched_at ?? null,
    announcement: getAnnouncement(),
    sources,
  };
}

/** 取出尚未生成 AI 摘要且未超过失败次数的在架条目。 */
export function listDealsForAi(
  limit: number,
  maxAttempts: number,
): AiPendingDeal[] {
  const now = new Date().toISOString();
  return getDb()
    .prepare(
      `SELECT id, title, description, source, category
       FROM deals
       WHERE ai_at IS NULL
         AND ai_attempts < ?
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY is_new DESC, COALESCE(published_at, first_seen_at) DESC, id DESC
       LIMIT ?`,
    )
    .all(maxAttempts, now, limit) as AiPendingDeal[];
}

/** 记录一次失败的摘要尝试，达到上限后不再重复消耗 AI 额度。 */
export function incrementAiAttempts(ids: number[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(', ');
  getDb()
    .prepare(
      `UPDATE deals
       SET ai_attempts = ai_attempts + 1
       WHERE id IN (${placeholders})`,
    )
    .run(...ids);
}

/** 保存 AI 摘要结果。 */
export function saveAiEnrichment(
  id: number,
  enrichment: AiEnrichment,
  model: string,
): void {
  getDb()
    .prepare(
      `UPDATE deals
       SET ai_title = ?, ai_summary = ?, ai_value = ?, ai_action = ?,
           ai_model = ?, ai_at = ?, ai_attempts = 0
       WHERE id = ?`,
    )
    .run(
      enrichment.title,
      enrichment.summary,
      enrichment.value,
      enrichment.action,
      model,
      new Date().toISOString(),
      id,
    );
}

/** 使用 SQLite 在线备份生成快照，并只保留最近若干份。 */
export function backupDatabase(dir: string, keep: number): string | null {
  const db = getDb();
  const targetDir = path.resolve(dir.trim() || path.join('data', 'backups'));
  fs.mkdirSync(targetDir, { recursive: true });

  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '')
    .replace('T', '-');
  const file = path.join(targetDir, `app-${stamp}.db`);

  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);

  const oldFiles = fs
    .readdirSync(targetDir)
    .filter((name) => /^app-\d{8}-\d{6}\.db$/.test(name))
    .sort()
    .reverse()
    .slice(keep);
  for (const name of oldFiles) {
    try {
      fs.unlinkSync(path.join(targetDir, name));
    } catch {
      // 忽略删除失败，下一轮继续尝试。
    }
  }

  return file;
}

