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
  SearchIndexStatus,
  SourceKind,
  SourceStatus,
  TagCandidate,
  TagStatus,
  TagSuggestion,
} from './types';
import {
  buildScopeWhere,
  deleteDealIndexesForExpired,
  deleteDealIndexesForRetention,
  deleteDealIndexesForSource,
  ensureSearchIndex,
  indexDealById,
  optimizeSearchIndex,
  readSearchIndexStatus,
  rebuildSearchIndex,
  searchDealsByFts,
  searchDealsByTag,
  startSearchIndexRebuild,
  type SearchCandidate,
  type SearchScopeOptions,
} from './search-index';
import { getTagRunProgress } from './tag-progress';

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
  ai_attempts INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '[]',
  proposed_tags TEXT NOT NULL DEFAULT '[]',
  entities TEXT NOT NULL DEFAULT '[]',
  ai_tags_at TEXT
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

CREATE TABLE IF NOT EXISTS tag_candidates (
  tag TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  merged_into TEXT,
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
  ai_tags_at: string | null;
  tags: string | null;
  proposed_tags: string | null;
  entities: string | null;
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
  ai_tags_at: string | null;
  tags: string | null;
  proposed_tags: string | null;
  entities: string | null;
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
  tags: string[];
  proposedTags: string[];
  entities: string[];
}

export interface AiTagPendingDeal {
  id: number;
  title: string;
  description: string;
  summary: string;
  source: string;
  category: Category;
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

function readSearchIndexMaxChars(db: Database.Database): number {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'env:AI_SEARCH_INDEX_MAX_CHARS'")
    .get() as { value: string } | undefined;
  const raw = row?.value ?? process.env.AI_SEARCH_INDEX_MAX_CHARS ?? '';
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 400;
  return Math.min(Math.max(Math.round(value), 200), 1000);
}

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
  ensureSearchIndex(db, readSearchIndexMaxChars(db));

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
    ['tags', "TEXT NOT NULL DEFAULT '[]'"],
    ['proposed_tags', "TEXT NOT NULL DEFAULT '[]'"],
    ['entities', "TEXT NOT NULL DEFAULT '[]'"],
    ['ai_tags_at', 'TEXT'],
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
    deleteDealIndexesForSource(db, id);
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
  const searchMaxChars = readSearchIndexMaxChars(db);

  const findExisting = db.prepare(
    `SELECT id, title, description, ai_title, ai_summary, ai_value, ai_action,
            ai_model, ai_at, ai_tags_at, tags, proposed_tags, entities
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
        ai_at = ?,
        tags = ?,
        proposed_tags = ?,
        entities = ?,
        ai_tags_at = ?
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
          contentChanged ? '[]' : existing.tags ?? '[]',
          contentChanged ? '[]' : existing.proposed_tags ?? '[]',
          contentChanged ? '[]' : existing.entities ?? '[]',
          contentChanged ? null : existing.ai_tags_at,
          item.link,
        );
        indexDealById(db, existing.id, searchMaxChars);
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
      if (result.changes > 0) {
        indexDealById(db, Number(result.lastInsertRowid), searchMaxChars);
      }
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

export function searchDealsForQuery(
  match: string,
  options: SearchScopeOptions,
): SearchCandidate[] | null {
  return searchDealsByFts(getDb(), match, options);
}

export function getSearchIndexStatus(): SearchIndexStatus {
  return readSearchIndexStatus(getDb());
}

export function rebuildSearchIndexNow(): SearchIndexStatus {
  const db = getDb();
  rebuildSearchIndex(db, readSearchIndexMaxChars(db));
  return readSearchIndexStatus(db);
}

/** 启动后台重建并立即返回当前进度，供后台轮询。 */
export function startSearchIndexRebuildNow(): SearchIndexStatus {
  const db = getDb();
  startSearchIndexRebuild(db, readSearchIndexMaxChars(db));
  return readSearchIndexStatus(db);
}

export function warmSearchIndex(): void {
  const db = getDb();
  ensureSearchIndex(db, readSearchIndexMaxChars(db));
}

/** 清理已过期条目与超过保留天数的条目。 */
export function pruneDeals(): number {
  const now = new Date().toISOString();
  const cutoff = new Date(
    Date.now() - getDataRetentionDays() * 24 * 60 * 60 * 1000,
  ).toISOString();

  const db = getDb();
  deleteDealIndexesForExpired(db, now);
  deleteDealIndexesForRetention(db, cutoff);

  const result = db
    .prepare(
      `DELETE FROM deals
       WHERE (expires_at IS NOT NULL AND expires_at <= ?)
          OR first_seen_at < ?`,
    )
    .run(now, cutoff);

  if (result.changes > 0) optimizeSearchIndex(db);

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

export function getVisibleSourceIds(): string[] {
  const db = getDb();
  const rows = db
    .prepare(
      'SELECT id FROM sources WHERE hidden = 0 ORDER BY sort_order ASC',
    )
    .all() as { id: string }[];
  return rows.map((row) => row.id);
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

/** 兼容 JSON 数组与逗号分隔两种历史写法。 */
export function parseStoredTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item).trim())
      .filter(Boolean)
      .slice(0, 8);
  }
  if (typeof value !== 'string' || value.trim() === '') return [];

  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parseStoredTags(parsed);
  } catch {
    // 旧数据可能是逗号分隔，继续按分隔符解析。
  }

  return value
    .split(/[,，、\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function mapDealRow(
  row: DealRow,
  nameMap: Map<string, string>,
): DealItem {
  return {
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
    tags: parseStoredTags(row.tags),
  };
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
    .map((row) => mapDealRow(row, nameMap));

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

export interface DealsListQuery {
  limit: number;
  cursor: string | null;
  sources: string[] | null;
  category: Category | null;
  onlyNew: boolean;
  ids: number[] | null;
}

export interface DealsListResult {
  items: DealItem[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
}

interface DealCursor {
  isNew: number;
  time: string;
  id: number;
}

function encodeDealCursor(item: DealItem): string {
  return Buffer.from(
    JSON.stringify([
      item.isNew ? 1 : 0,
      item.publishedAt ?? item.firstSeenAt,
      item.id,
    ]),
  ).toString('base64url');
}

function decodeDealCursor(raw: string): DealCursor | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    ) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;

    const [isNew, time, id] = parsed;
    if (
      typeof isNew !== 'number' ||
      typeof time !== 'string' ||
      typeof id !== 'number'
    ) {
      return null;
    }
    return { isNew, time, id };
  } catch {
    return null;
  }
}

/** 首页元信息，不加载条目本身。 */
export function getDealsMeta(): Omit<DealsSnapshot, 'items'> {
  const db = getDb();
  const now = new Date().toISOString();
  const retentionCutoff = new Date(
    Date.now() - getDataRetentionDays() * 24 * 60 * 60 * 1000,
  ).toISOString();

  const lastRun = db
    .prepare('SELECT fetched_at FROM fetch_runs ORDER BY id DESC LIMIT 1')
    .get() as { fetched_at: string } | undefined;

  const statusRows = db
    .prepare('SELECT source, ok, count, error, fetched_at FROM source_status')
    .all() as StatusRow[];

  const countRows = db
    .prepare(
      `SELECT source, COUNT(*) AS count FROM deals
       WHERE (expires_at IS NULL OR expires_at > ?)
         AND first_seen_at >= ?
       GROUP BY source`,
    )
    .all(now, retentionCutoff) as SourceCountRow[];

  const stored = listSources();
  const visible = stored.filter((source) => !source.hidden);
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

  const activeCount = visible.reduce(
    (sum, source) => sum + (countMap.get(source.id) ?? 0),
    0,
  );

  let newCount = 0;
  if (visible.length > 0) {
    const placeholders = visible.map(() => '?').join(', ');
    newCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM deals
           WHERE is_new = 1
             AND (expires_at IS NULL OR expires_at > ?)
             AND first_seen_at >= ?
             AND source IN (${placeholders})`,
        )
        .get(now, retentionCutoff, ...visible.map((s) => s.id)) as {
        count: number;
      }
    ).count;
  }

  return {
    fetchedAt: lastRun?.fetched_at ?? null,
    sources,
    stats: { activeCount, newCount },
    announcement: getAnnouncement(),
    aiSearchEnabled: getAiSearchEnabled(),
  };
}

/**
 * 按游标分页读取首页条目。
 * 排序与旧版一致：新条目优先，其次发布时间倒序，最后 id 倒序。
 */
export function getDealsList(query: DealsListQuery): DealsListResult {
  const empty: DealsListResult = {
    items: [],
    total: 0,
    hasMore: false,
    nextCursor: null,
  };

  const db = getDb();
  const now = new Date().toISOString();
  const retentionCutoff = new Date(
    Date.now() - getDataRetentionDays() * 24 * 60 * 60 * 1000,
  ).toISOString();

  const stored = listSources();
  const nameMap = new Map(stored.map((source) => [source.id, source.name]));
  const visible = stored
    .filter((source) => !source.hidden)
    .map((source) => source.id);
  if (visible.length === 0) return empty;

  const allowed =
    query.sources && query.sources.length > 0
      ? query.sources.filter((id) => visible.includes(id))
      : visible;
  if (allowed.length === 0) return empty;

  const clauses = [
    '(d.expires_at IS NULL OR d.expires_at > ?)',
    'd.first_seen_at >= ?',
    `d.source IN (${allowed.map(() => '?').join(', ')})`,
  ];
  const params: unknown[] = [now, retentionCutoff, ...allowed];

  if (query.category) {
    clauses.push('d.category = ?');
    params.push(query.category);
  }
  if (query.onlyNew) clauses.push('d.is_new = 1');

  const ids = query.ids ? query.ids.slice(0, 500) : null;
  if (ids) {
    if (ids.length === 0) return empty;
    clauses.push(`d.id IN (${ids.map(() => '?').join(', ')})`);
    params.push(...ids);
  }

  const where = clauses.join(' AND ');
  const total = (
    db
      .prepare(`SELECT COUNT(*) AS count FROM deals d WHERE ${where}`)
      .get(...params) as { count: number }
  ).count;

  if (ids) {
    const rows = db
      .prepare(
        `SELECT d.*, 0 AS claimed, 0 AS favorite
         FROM deals d
         WHERE ${where}
         ORDER BY d.is_new DESC,
                  COALESCE(d.published_at, d.first_seen_at) DESC,
                  d.id DESC
         LIMIT ?`,
      )
      .all(...params, ids.length) as DealRow[];

    return {
      items: rows.map((row) => mapDealRow(row, nameMap)),
      total: rows.length,
      hasMore: false,
      nextCursor: null,
    };
  }

  const limit = Math.min(Math.max(Math.round(query.limit), 1), 120);
  const cursor = query.cursor ? decodeDealCursor(query.cursor) : null;

  let cursorSql = '';
  const cursorParams: unknown[] = [];
  if (cursor) {
    cursorSql = `AND (
      d.is_new < ?
      OR (d.is_new = ? AND COALESCE(d.published_at, d.first_seen_at) < ?)
      OR (d.is_new = ? AND COALESCE(d.published_at, d.first_seen_at) = ? AND d.id < ?)
    )`;
    cursorParams.push(
      cursor.isNew,
      cursor.isNew,
      cursor.time,
      cursor.isNew,
      cursor.time,
      cursor.id,
    );
  }

  const pageRows = db
    .prepare(
      `SELECT d.*, 0 AS claimed, 0 AS favorite
       FROM deals d
       WHERE ${where} ${cursorSql}
       ORDER BY d.is_new DESC,
                COALESCE(d.published_at, d.first_seen_at) DESC,
                d.id DESC
       LIMIT ?`,
    )
    .all(...params, ...cursorParams, limit + 1) as DealRow[];

  const hasMore = pageRows.length > limit;
  const rows = hasMore ? pageRows.slice(0, limit) : pageRows;
  const items = rows.map((row) => mapDealRow(row, nameMap));

  return {
    items,
    total,
    hasMore,
    nextCursor:
      hasMore && items.length > 0
        ? encodeDealCursor(items[items.length - 1])
        : null,
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
    searchIndex: readSearchIndexStatus(db),
    tags: getTagStatus(),
    tagCandidates: getTagCandidates(100),
  };
}

/** 标签开关、覆盖率与补全进度。 */
export function getTagStatus(): TagStatus {
  const coverage = getTagCoverage();
  const progress = getTagRunProgress();
  const raw = getRuntimeEnvRaw('AI_TAGS_ENABLED');

  return {
    enabled: raw === null || raw.trim() === '' || raw.trim() !== 'false',
    ...coverage,
    running: progress.running,
    processed: progress.processed,
    batchTotal: progress.batchTotal,
    taggedThisRun: progress.tagged,
    failedThisRun: progress.failed,
    startedAt: progress.startedAt,
    finishedAt: progress.finishedAt,
    lastError: progress.error,
    promoteThreshold: readRuntimeNumber(
      getDb(),
      'AI_TAGS_PROMOTE_THRESHOLD',
      3,
      2,
      20,
    ),
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
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE deals
     SET ai_title = ?, ai_summary = ?, ai_value = ?, ai_action = ?,
         tags = ?, proposed_tags = ?, entities = ?, ai_tags_at = ?,
         ai_model = ?, ai_at = ?, ai_attempts = 0
     WHERE id = ?`,
  ).run(
    enrichment.title,
    enrichment.summary,
    enrichment.value,
    enrichment.action,
    JSON.stringify(enrichment.tags),
    JSON.stringify(enrichment.proposedTags),
    JSON.stringify(enrichment.entities),
    now,
    model,
    now,
    id,
  );
  recordCandidates(db, enrichment.proposedTags);
  indexDealById(db, id, readSearchIndexMaxChars(db));
}

/** 只更新标签与实体，用于存量数据补全。 */
export function saveDealTags(
  id: number,
  tags: string[],
  proposedTags: string[],
  entities: string[],
): void {
  const db = getDb();
  db.prepare(
    `UPDATE deals
     SET tags = ?, proposed_tags = ?, entities = ?, ai_tags_at = ?
     WHERE id = ?`,
  ).run(
    JSON.stringify(tags.slice(0, 2)),
    JSON.stringify(proposedTags.slice(0, 3)),
    JSON.stringify(entities.slice(0, 6)),
    new Date().toISOString(),
    id,
  );
  recordCandidates(db, proposedTags);
  indexDealById(db, id, readSearchIndexMaxChars(db));
}

/** 已有摘要但尚未打过标签的在架条目。 */
export function listDealsMissingTags(
  limit: number,
  force = false,
): AiTagPendingDeal[] {
  const now = new Date().toISOString();
  return getDb()
    .prepare(
      `SELECT id, title, description, COALESCE(ai_summary, '') AS summary,
              source, category
       FROM deals
       WHERE ai_summary IS NOT NULL
         AND ai_summary <> ''
         AND ${force ? '1 = 1' : 'ai_tags_at IS NULL'}
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY is_new DESC, COALESCE(published_at, first_seen_at) DESC, id DESC
       LIMIT ?`,
    )
    .all(now, limit) as AiTagPendingDeal[];
}

/** 统计标签覆盖率，后台展示用。 */
export function getTagCoverage(): {
  total: number;
  tagged: number;
  pending: number;
} {
  const row = getDb()
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN tags IS NOT NULL AND tags NOT IN ('', '[]') THEN 1 ELSE 0 END) AS tagged,
         SUM(CASE WHEN ai_summary IS NOT NULL AND ai_summary <> ''
                   AND ai_tags_at IS NULL THEN 1 ELSE 0 END) AS pending
       FROM deals`,
    )
    .get() as { total: number; tagged: number | null; pending: number | null };

  return {
    total: row.total,
    tagged: row.tagged ?? 0,
    pending: row.pending ?? 0,
  };
}

/** 读取运行时数字配置，允许 0 以外的最小值兜底。 */
function readRuntimeNumber(
  db: Database.Database,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const row = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(`env:${key}`) as { value: string } | undefined;
  const raw = row?.value ?? process.env[key] ?? '';
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.max(Math.round(value), min), max);
}

/** 已被管理员转正的提议标签，会并入受控词表。 */
export function getPromotedTags(): string[] {
  return readPromotedTags(getDb());
}

function readPromotedTags(db: Database.Database): string[] {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'ai:promoted_tags'")
    .get() as { value: string } | undefined;
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => String(item).trim())
      .filter((item) => item.length >= 2 && item.length <= 12)
      .slice(0, 200);
  } catch {
    return [];
  }
}

/** 记录 AI 提出的候选标签，超出候选池上限时优先保留被多次使用的。 */
function recordCandidates(db: Database.Database, tags: string[]): void {
  const entries = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
  if (entries.length === 0) return;

  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO tag_candidates (tag, status, merged_into, created_at, updated_at)
     VALUES (?, 'pending', NULL, ?, ?)
     ON CONFLICT(tag) DO NOTHING`,
  );
  for (const tag of entries) insert.run(tag, now, now);

  const limit = readRuntimeNumber(db, 'AI_TAGS_CANDIDATE_LIMIT', 500, 50, 5000);
  const pending = (
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM tag_candidates WHERE status = 'pending'",
      )
      .get() as { count: number }
  ).count;
  if (pending <= limit) return;

  // 先删掉只出现过一次的候选，再从最旧的开始截断到上限。
  db.prepare(
    `DELETE FROM tag_candidates
     WHERE status = 'pending'
       AND tag IN (
         SELECT c.tag
         FROM tag_candidates c
         LEFT JOIN (
           SELECT j.value AS tag, COUNT(*) AS count
           FROM deals d, json_each(d.proposed_tags) j
           GROUP BY j.value
         ) t ON t.tag = c.tag
         WHERE c.status = 'pending' AND COALESCE(t.count, 0) < 2
       )`,
  ).run();

  db.prepare(
    `DELETE FROM tag_candidates
     WHERE status = 'pending'
       AND tag IN (
         SELECT tag FROM tag_candidates
         WHERE status = 'pending'
         ORDER BY updated_at DESC
         LIMIT -1 OFFSET ?
       )`,
  ).run(limit);
}

/** 候选池列表，按状态与使用次数排序。 */
export function getTagCandidates(limit = 100): TagCandidate[] {
  const rows = getDb()
    .prepare(
      `SELECT c.tag, c.status, c.merged_into, COALESCE(t.count, 0) AS count
       FROM tag_candidates c
       LEFT JOIN (
         SELECT j.value AS tag, COUNT(*) AS count
         FROM deals d, json_each(d.proposed_tags) j
         GROUP BY j.value
       ) t ON t.tag = c.tag
       ORDER BY CASE c.status WHEN 'pending' THEN 0 ELSE 1 END ASC,
                COALESCE(t.count, 0) DESC,
                c.updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as {
    tag: string;
    status: string;
    merged_into: string | null;
    count: number;
  }[];

  return rows.map((row) => ({
    tag: row.tag,
    count: row.count,
    status: row.status as TagCandidate['status'],
    mergedInto: row.merged_into,
  }));
}

/** 一键转正：加入正式词表，并把存量条目里的提议标签提升为核心标签。 */
export function promoteTag(tag: string): void {
  const db = getDb();
  const promoted = readPromotedTags(db);
  if (!promoted.includes(tag)) {
    setSetting(
      'ai:promoted_tags',
      JSON.stringify([...promoted, tag].slice(0, 200)),
    );
  }

  const now = new Date().toISOString();
  const rows = db
    .prepare(
      `SELECT id, tags, proposed_tags FROM deals
       WHERE EXISTS (SELECT 1 FROM json_each(proposed_tags) WHERE value = ?)
       LIMIT 20000`,
    )
    .all(tag) as {
    id: number;
    tags: string | null;
    proposed_tags: string | null;
  }[];

  const update = db.prepare(
    'UPDATE deals SET tags = ?, proposed_tags = ? WHERE id = ?',
  );
  const searchMaxChars = readSearchIndexMaxChars(db);

  const apply = db.transaction(() => {
    for (const row of rows) {
      const tags = parseStoredTags(row.tags).filter((item) => item !== tag);
      const proposed = parseStoredTags(row.proposed_tags).filter(
        (item) => item !== tag,
      );

      // 核心标签正常上限为 2 个；转正回填允许到 3 个，避免已满时丢词。
      if (!tags.includes(tag) && tags.length < 3) {
        tags.push(tag);
        update.run(JSON.stringify(tags), JSON.stringify(proposed), row.id);
        indexDealById(db, row.id, searchMaxChars);
        continue;
      }

      if (!tags.includes(tag)) continue;
      update.run(JSON.stringify(tags), JSON.stringify(proposed), row.id);
      indexDealById(db, row.id, searchMaxChars);
    }

    db.prepare(
      `UPDATE tag_candidates SET status = 'promoted', updated_at = ? WHERE tag = ?`,
    ).run(now, tag);
  });

  apply();
}

/** 屏蔽候选：不再进入标签建议，也不会自动转正。 */
export function blockTag(tag: string): void {
  getDb()
    .prepare(
      `UPDATE tag_candidates SET status = 'blocked', updated_at = ? WHERE tag = ?`,
    )
    .run(new Date().toISOString(), tag);
}

/** 把候选合并到另一个标签，并同步改写已入库条目。 */
export function mergeTag(from: string, to: string): void {
  const target = to.trim();
  if (!target || target === from) return;

  const db = getDb();
  const now = new Date().toISOString();
  const targetIsCandidate = Boolean(
    db.prepare('SELECT 1 FROM tag_candidates WHERE tag = ?').get(target),
  );
  const rows = db
    .prepare(
      `SELECT id, tags, proposed_tags FROM deals
       WHERE EXISTS (SELECT 1 FROM json_each(proposed_tags) WHERE value = ?)
       LIMIT 20000`,
    )
    .all(from) as {
    id: number;
    tags: string | null;
    proposed_tags: string | null;
  }[];

  const update = db.prepare(
    'UPDATE deals SET tags = ?, proposed_tags = ? WHERE id = ?',
  );
  const searchMaxChars = readSearchIndexMaxChars(db);

  const apply = db.transaction(() => {
    for (const row of rows) {
      const tags = parseStoredTags(row.tags).filter((tag) => tag !== from);
      const proposed = parseStoredTags(row.proposed_tags).filter(
        (tag) => tag !== from,
      );

      if (targetIsCandidate) {
        if (!proposed.includes(target) && proposed.length < 8) {
          proposed.push(target);
        }
      } else if (!tags.includes(target) && tags.length < 2) {
        tags.push(target);
      }

      update.run(JSON.stringify(tags), JSON.stringify(proposed), row.id);
      indexDealById(db, row.id, searchMaxChars);
    }

    db.prepare(
      `UPDATE tag_candidates
       SET status = 'merged', merged_into = ?, updated_at = ?
       WHERE tag = ?`,
    ).run(target, now, from);

    if (targetIsCandidate) {
      db.prepare(
        `INSERT OR IGNORE INTO tag_candidates
           (tag, status, merged_into, created_at, updated_at)
         VALUES (?, 'pending', NULL, ?, ?)`,
      ).run(target, now, now);
    }
  });

  apply();
}

/** 精确按标签召回，标签建议点击后使用，不再调用 AI。 */
export function searchDealsForTag(
  tag: string,
  options: SearchScopeOptions,
): SearchCandidate[] {
  return searchDealsByTag(getDb(), tag, options);
}

/** 正式标签在搜索范围内的使用条数，供 AI 语义建议挑选候选。 */
export function listFormalTagCounts(
  options: SearchScopeOptions,
): TagSuggestion[] {
  const scope = buildScopeWhere(options);
  return getDb()
    .prepare(
      `SELECT j.value AS tag, COUNT(*) AS count
       FROM deals d
       JOIN json_each(d.tags) j
       WHERE 1 = 1 ${scope.sql}
       GROUP BY j.value
       HAVING count > 0
       ORDER BY count DESC, j.value ASC
       LIMIT 200`,
    )
    .all(...scope.params) as TagSuggestion[];
}

/**
 * 零结果时推荐可点击的标签：
 * 正式标签只要求被至少一条优惠使用，提议标签需达到转正阈值。
 */
export function getTagSuggestions(
  keywords: string[],
  options: SearchScopeOptions,
  limit: number,
): TagSuggestion[] {
  const needles = [
    ...new Set(
      keywords
        .map((keyword) => keyword.trim().toLowerCase())
        .filter((keyword) => keyword.length >= 2),
    ),
  ];
  if (needles.length === 0 || limit <= 0) return [];

  const db = getDb();
  const scope = buildScopeWhere(options);

  const countTags = (column: 'tags' | 'proposed_tags') =>
    db
      .prepare(
        `SELECT j.value AS tag, COUNT(*) AS count
         FROM deals d
         JOIN json_each(d.${column}) j
         WHERE 1 = 1 ${scope.sql}
         GROUP BY j.value`,
      )
      .all(...scope.params) as { tag: string; count: number }[];

  const formal = countTags('tags');
  const proposed = countTags('proposed_tags');
  const threshold = readRuntimeNumber(
    db,
    'AI_TAGS_PROMOTE_THRESHOLD',
    3,
    2,
    20,
  );

  const merged = new Map<string, number>();
  for (const row of formal) {
    if (row.count > 0) merged.set(row.tag, row.count);
  }
  for (const row of proposed) {
    if (row.count < threshold) continue;
    merged.set(row.tag, (merged.get(row.tag) ?? 0) + row.count);
  }

  const hidden = new Set(
    (
      db
        .prepare(
          "SELECT tag FROM tag_candidates WHERE status IN ('blocked', 'merged')",
        )
        .all() as { tag: string }[]
    ).map((row) => row.tag),
  );

  const scored: { tag: string; count: number; score: number }[] = [];
  for (const [tag, count] of merged) {
    if (hidden.has(tag)) continue;
    const lower = tag.toLowerCase();
    let score = 0;
    for (const needle of needles) {
      if (lower === needle) {
        score = Math.max(score, 3);
      } else if (needle.includes(lower) || lower.includes(needle)) {
        score = Math.max(score, 2);
      }
    }
    if (score > 0) scored.push({ tag, count, score });
  }

  return scored
    .sort(
      (left, right) =>
        right.score - left.score || right.count - left.count,
    )
    .slice(0, limit)
    .map((row) => ({ tag: row.tag, count: row.count }));
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

