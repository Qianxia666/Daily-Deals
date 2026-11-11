import Database from 'better-sqlite3';
import { randomBytes, randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BUILTIN_SOURCES } from './sources';
import type { RawDeal } from './fetchers/types';
import type {
  AccountUser,
  AdminBaseData,
  AdminSource,
  AdminUser,
  AdminUserDetail,
  AiQuota,
  Announcement,
  ChannelKind,
  DealItem,
  DealsResponse,
  DeliveryRecord,
  DigestItem,
  InviteCode,
  PublicDigest,
  SearchIndexStatus,
  SourceKind,
  SourceState,
  SourceStatus,
  TagCandidate,
  TagStatus,
  TagSuggestion,
  UserChannel,
  UserSubscription,
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
  ai_tags_at TEXT,
  body_fetched_at TEXT
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
  state TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS removed_sources (
  id TEXT PRIMARY KEY,
  removed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tag_candidates (
  tag TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  merged_into TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_login_at TEXT,
  disabled INTEGER NOT NULL DEFAULT 0,
  ai_quota_date TEXT,
  ai_quota_used INTEGER NOT NULL DEFAULT 0,
  invite_code TEXT
);

CREATE TABLE IF NOT EXISTS invite_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  max_uses INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invite_codes_created ON invite_codes(created_at);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  webhook TEXT NOT NULL DEFAULT '',
  secret TEXT NOT NULL DEFAULT '',
  channel_key TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_channels_user ON channels(user_id);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  keyword TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_user_keyword
  ON subscriptions(user_id, keyword COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  subscription_id INTEGER NOT NULL,
  channel_id INTEGER NOT NULL,
  deal_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  UNIQUE(subscription_id, channel_id, deal_id),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries(status, id);
CREATE INDEX IF NOT EXISTS idx_deliveries_user ON deliveries(user_id, id);

CREATE TABLE IF NOT EXISTS daily_digests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  channel_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  digest_date TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  lines TEXT NOT NULL DEFAULT '[]',
  items TEXT NOT NULL DEFAULT '[]',
  item_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  UNIQUE(user_id, channel_id, kind, digest_date),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_digests_status ON daily_digests(status, id);
CREATE INDEX IF NOT EXISTS idx_digests_date ON daily_digests(digest_date);

CREATE TABLE IF NOT EXISTS keyword_vectors (
  keyword TEXT PRIMARY KEY COLLATE NOCASE,
  vector BLOB NOT NULL,
  dims INTEGER NOT NULL,
  model TEXT NOT NULL,
  source_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vector_match_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id INTEGER NOT NULL,
  keyword TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  score REAL NOT NULL,
  pushed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(deal_id, keyword, user_id)
);
CREATE INDEX IF NOT EXISTS idx_vector_log_created ON vector_match_log(created_at);

CREATE TABLE IF NOT EXISTS public_digests (
  digest_date TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  stats TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  groups TEXT NOT NULL DEFAULT '[]',
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
  body_fetched_at: string | null;
  tags: string | null;
  proposed_tags: string | null;
  entities: string | null;
}

export interface AiPendingDeal {
  id: number;
  title: string;
  description: string;
  source: string;
}

export interface AiEnrichment {
  title: string;
  summary: string;
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
  state: string;
}

export interface StoredSource {
  id: string;
  name: string;
  url: string;
  kind: SourceKind;
  order: number;
  state: SourceState;
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
  state: SourceState;
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
  state: SourceState;
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
    ['body_fetched_at', 'TEXT'],
    ['vector', 'BLOB'],
    ['vector_model', 'TEXT'],
    ['vector_at', 'TEXT'],
  ];

  for (const [name, type] of additions) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE deals ADD COLUMN ${name} ${type}`);
    }
  }

  // 旧库的 category 字段已被标签体系取代，直接移除。
  if (existing.has('category')) {
    try {
      db.exec('ALTER TABLE deals DROP COLUMN category');
    } catch (error) {
      console.warn('[db] 移除 category 字段失败，已忽略', error);
    }
  }

  const userColumns = db.prepare('PRAGMA table_info(users)').all() as {
    name: string;
  }[];
  if (!userColumns.some((column) => column.name === 'invite_code')) {
    db.exec('ALTER TABLE users ADD COLUMN invite_code TEXT');
  }

  // 来源隐藏状态统一升级为三态：hidden=1 → paused，其余按 active。
  const sourceColumns = db.prepare('PRAGMA table_info(sources)').all() as {
    name: string;
  }[];
  if (!sourceColumns.some((column) => column.name === 'state')) {
    db.exec(
      "ALTER TABLE sources ADD COLUMN state TEXT NOT NULL DEFAULT 'active'",
    );
    db.exec(
      "UPDATE sources SET state = CASE WHEN hidden = 1 THEN 'paused' ELSE 'active' END",
    );
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

  // 旧版删除内置来源时只写了墓碑；这里补成 state='removed' 的真实记录，便于后台恢复。
  const tombstones = new Set(
    (
      db.prepare('SELECT id FROM removed_sources').all() as { id: string }[]
    ).map((row) => row.id),
  );

  let maxOrder = existingRows.reduce(
    (max, row) => Math.max(max, row.sort_order),
    -1,
  );

  const insert = db.prepare(`
    INSERT OR IGNORE INTO sources (
      id, name, url, kind, sort_order, hidden, enabled, builtin,
      refresh_minutes, state, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, 1, 1, NULL, ?, ?, ?)
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

      const state: SourceState = tombstones.has(source.id)
        ? 'removed'
        : old?.hidden
          ? 'paused'
          : 'active';

      insert.run(
        source.id,
        source.name,
        source.url,
        source.kind,
        order,
        state,
        now,
        now,
      );
    }

    // 墓碑已经转成真实记录，清空旧表避免之后重复参与判断。
    db.prepare('DELETE FROM removed_sources').run();
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
    state: (row.state as SourceState) || 'active',
    refreshMinutes: row.refresh_minutes,
    builtin: row.builtin === 1,
  };
}

/** 返回所有来源（包含停用与已移除，由调用方按 state 过滤）。 */
export function listSources(): StoredSource[] {
  const rows = getDb()
    .prepare(
      `SELECT id, name, url, kind, sort_order, hidden, enabled, builtin, refresh_minutes, state
       FROM sources WHERE enabled = 1
       ORDER BY sort_order ASC, id ASC`,
    )
    .all() as SourceRow[];
  return rows.map(toStoredSource);
}

export function getSource(id: string): StoredSource | null {
  const row = getDb()
    .prepare(
      `SELECT id, name, url, kind, sort_order, hidden, enabled, builtin, refresh_minutes, state
       FROM sources WHERE id = ?`,
    )
    .get(id) as SourceRow | undefined;
  return row ? toStoredSource(row) : null;
}

/** 新增自定义来源；id 已存在时返回 null。 */
export function createSource(input: NewSourceInput): StoredSource | null {
  const db = getDb();
  const existing = getSource(input.id);

  // 命中已移除的来源时直接恢复并覆盖配置，避免造出同名但解析器错误的假源。
  if (existing) {
    if (existing.state !== 'removed') return null;

    db.prepare(
      `UPDATE sources
       SET name = ?, url = ?, kind = ?, state = ?, refresh_minutes = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      input.name,
      input.url,
      // 恢复已移除的来源时沿用原解析器，避免把线报酷等专用源误改成 RSS。
      existing.kind,
      'active',
      input.refreshMinutes,
      new Date().toISOString(),
      input.id,
    );
    return getSource(input.id);
  }

  const maxOrder = db
    .prepare('SELECT MAX(sort_order) AS value FROM sources')
    .get() as { value: number | null };
  const order = (maxOrder.value ?? -1) + 1;
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO sources (
       id, name, url, kind, sort_order, hidden, enabled, builtin,
       refresh_minutes, state, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 0, 1, 0, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.name,
    input.url,
    input.kind,
    order,
    input.refreshMinutes,
    input.state,
    now,
    now,
  );
  // 重新添加同标识来源时，清除此前的内置来源移除标记。
  db.prepare('DELETE FROM removed_sources WHERE id = ?').run(input.id);

  return getSource(input.id);
}

/** 移除来源：软删除，保留定义以便恢复；同时清空已入库条目与抓取状态。 */
export function deleteSource(id: string): boolean {
  const db = getDb();
  const source = getSource(id);
  if (!source) return false;

  const remove = db.transaction(() => {
    deleteDealIndexesForSource(db, id);
    db.prepare('DELETE FROM deals WHERE source = ?').run(id);
    db.prepare('DELETE FROM source_status WHERE source = ?').run(id);
    db.prepare('UPDATE sources SET state = ?, updated_at = ? WHERE id = ?').run(
      'removed',
      new Date().toISOString(),
      id,
    );
  });

  remove();
  return true;
}

/** 恢复已移除的来源；恢复后等待下一轮调度重新抓取。 */
export function restoreSource(id: string): boolean {
  const result = getDb()
    .prepare("UPDATE sources SET state = 'active', updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), id);
  return result.changes > 0;
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
    `SELECT id, title, description, ai_title, ai_summary,
            ai_model, ai_at, ai_tags_at, body_fetched_at,
            tags, proposed_tags, entities
     FROM deals WHERE link = ?`,
  );
  const updateExisting = db.prepare(`
    UPDATE deals
    SET title = ?,
        description = ?,
        expires_at = COALESCE(?, expires_at),
        published_at = COALESCE(?, published_at),
        last_seen_at = ?,
        ai_title = ?,
        ai_summary = ?,
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
      link, title, description, source,
      expires_at, published_at, is_new, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(link) DO NOTHING
  `);

  const write = db.transaction((items: RawDeal[]) => {
    let inserted = 0;

    for (const item of items) {
      const existing = findExisting.get(item.link) as
        | ExistingDealRow
        | undefined;

      if (existing) {
        // 正文已经补全的条目，列表页的摘要不再覆盖，避免把完整正文刷回摘要。
        if (existing.body_fetched_at && !item.bodyComplete) {
          db.prepare('UPDATE deals SET last_seen_at = ? WHERE id = ?').run(
            now,
            existing.id,
          );
          continue;
        }

        const nextDescription = item.description || existing.description;
        const contentChanged =
          item.title !== existing.title ||
          nextDescription !== existing.description;

        updateExisting.run(
          item.title,
          nextDescription,
          item.expiresAt,
          item.publishedAt,
          now,
          contentChanged ? null : existing.ai_title,
          contentChanged ? null : existing.ai_summary,
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
      "SELECT id FROM sources WHERE state = 'active' AND enabled = 1 ORDER BY sort_order ASC",
    )
    .all() as { id: string }[];
  return rows.map((row) => row.id);
}

/** 来源是否对外可见（启用且未停用/移除）；来源记录不存在时视为不可见。 */
export function isSourceVisible(sourceId: string): boolean {
  const row = getDb()
    .prepare('SELECT state, enabled FROM sources WHERE id = ?')
    .get(sourceId) as { state: string; enabled: number } | undefined;
  return Boolean(row && row.state === 'active' && row.enabled === 1);
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
    expiresAt: row.expires_at,
    publishedAt: row.published_at,
    firstSeenAt: row.first_seen_at,
    isNew: row.is_new === 1,
    favorite: row.favorite === 1,
    aiTitle: row.ai_title,
    aiSummary: row.ai_summary,
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
              0 AS favorite
       FROM deals d
       WHERE (d.expires_at IS NULL OR d.expires_at > ?)
         AND d.first_seen_at >= ?
       ORDER BY COALESCE(d.published_at, d.first_seen_at) DESC,
                d.id DESC`,
    )
    .all(now, retentionCutoff) as DealRow[];

  const stored = listSources();
  const nameMap = new Map(stored.map((source) => [source.id, source.name]));
  const visible = stored.filter((source) => source.state === 'active');
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
  onlyNew: boolean;
  ids: number[] | null;
  preferTags?: string[] | null;
}

export interface DealsListResult {
  items: DealItem[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
}

interface DealCursor {
  time: string;
  id: number;
}

function encodeDealCursor(item: DealItem): string {
  return Buffer.from(
    JSON.stringify([item.publishedAt ?? item.firstSeenAt, item.id]),
  ).toString('base64url');
}

function decodeDealCursor(raw: string): DealCursor | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    ) as unknown;
    if (!Array.isArray(parsed)) return null;

    // 兼容旧版 [isNew, time, id] 游标，只取后两段。
    const parts = parsed.length === 3 ? parsed.slice(1) : parsed;
    if (parts.length !== 2) return null;

    const [time, id] = parts;
    if (typeof time !== 'string' || typeof id !== 'number') return null;
    return { time, id };
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
  const visible = stored.filter((source) => source.state === 'active');
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

export interface PopularTag {
  tag: string;
  count: number;
}

/** 统计在架优惠的标签频次，用于「猜你喜欢」的品类选择。 */
export function getPopularTags(limit = 500): PopularTag[] {
  const db = getDb();
  const now = new Date().toISOString();
  const retentionCutoff = new Date(
    Date.now() - getDataRetentionDays() * 24 * 60 * 60 * 1000,
  ).toISOString();
  const visible = listSources()
    .filter((source) => source.state === 'active')
    .map((source) => source.id);
  if (visible.length === 0) return [];

  return db
    .prepare(
      `SELECT json_each.value AS tag, COUNT(*) AS count
       FROM deals d, json_each(d.tags)
       WHERE (d.expires_at IS NULL OR d.expires_at > ?)
         AND d.first_seen_at >= ?
         AND d.source IN (${visible.map(() => '?').join(', ')})
         AND length(json_each.value) BETWEEN 2 AND 12
       GROUP BY json_each.value
       ORDER BY count DESC, tag ASC
       LIMIT ?`,
    )
    .all(
      now,
      retentionCutoff,
      ...visible,
      Math.min(Math.max(limit, 1), 1000),
    ) as PopularTag[];
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
    .filter((source) => source.state === 'active')
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

  if (query.onlyNew) clauses.push('d.is_new = 1');
  if (query.preferTags && query.preferTags.length > 0) {
    clauses.push(
      `EXISTS (
        SELECT 1 FROM json_each(d.tags)
        WHERE json_each.value IN (${query.preferTags.map(() => '?').join(', ')})
      )`,
    );
    params.push(...query.preferTags);
  }

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
        `SELECT d.*, 0 AS favorite
         FROM deals d
         WHERE ${where}
         ORDER BY COALESCE(d.published_at, d.first_seen_at) DESC,
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
      COALESCE(d.published_at, d.first_seen_at) < ?
      OR (COALESCE(d.published_at, d.first_seen_at) = ? AND d.id < ?)
    )`;
    cursorParams.push(cursor.time, cursor.time, cursor.id);
  }

  const pageRows = db
    .prepare(
      `SELECT d.*, 0 AS favorite
       FROM deals d
       WHERE ${where} ${cursorSql}
       ORDER BY COALESCE(d.published_at, d.first_seen_at) DESC,
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
        state = ?,
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
        item.state,
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
      state: source.state,
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
    users: listAdminUsers(),
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

export interface PendingBodyDeal {
  id: number;
  link: string;
  source: string;
  kind: string;
}

/**
 * 历史积压不再回补：只处理这个时间点之后入库的条目。
 * 需要重新放开历史补全时，把这个值往前改即可。
 */
const BACKFILL_SINCE = '2026-11-11T02:12:00.000Z';

/**
 * 待补全正文的条目：只取启用来源、尚未补全、未过期且入库时间在截止点之后的记录。
 */
export function listPendingBodyDeals(limit = 1): PendingBodyDeal[] {
  return getDb()
    .prepare(
      `SELECT d.id, d.link, d.source, s.kind
       FROM deals d
       JOIN sources s ON s.id = d.source
       WHERE s.kind IN ('sina_weibo', 'xianbao')
         AND s.state = 'active'
         AND s.enabled = 1
         AND d.body_fetched_at IS NULL
         AND d.first_seen_at >= ?
         AND (d.expires_at IS NULL OR d.expires_at > ?)
       ORDER BY d.id DESC
       LIMIT ?`,
    )
    .all(
      BACKFILL_SINCE,
      new Date().toISOString(),
      limit,
    ) as PendingBodyDeal[];
}

/** 写入完整正文，并清空 AI 结果，让摘要按新正文重新生成。title 为空时保留原标题。 */
export function saveDealBody(
  id: number,
  title: string | null,
  description: string,
): void {
  const db = getDb();
  const now = new Date().toISOString();

  db.prepare(
    `UPDATE deals
     SET title = COALESCE(?, title),
         description = ?,
         body_fetched_at = ?,
         ai_title = NULL,
         ai_summary = NULL,
         ai_value = NULL,
         ai_action = NULL,
         ai_model = NULL,
         ai_at = NULL,
         ai_attempts = 0,
         ai_tags_at = NULL,
         tags = '[]',
         proposed_tags = '[]',
         entities = '[]',
         last_seen_at = ?
     WHERE id = ?`,
  ).run(title, description, now, now, id);

  indexDealById(db, id, readSearchIndexMaxChars(db));
}

/** 详情抓取失败时标记为已尝试，保留摘要，避免反复重试。 */
export function markDealBodyFetched(id: number): void {
  getDb()
    .prepare('UPDATE deals SET body_fetched_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id);
}

/** 取出尚未生成 AI 摘要且未超过失败次数的在架条目。 */
export function listDealsForAi(
  limit: number,
  maxAttempts: number,
): AiPendingDeal[] {
  const now = new Date().toISOString();
  // 微博镜像先补正文再生成摘要；超过 24 小时仍未补到正文的，用摘要兜底，避免长期不展示。
  const bodyDeadline = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  return getDb()
    .prepare(
      `SELECT id, title, description, source
       FROM deals
       WHERE ai_at IS NULL
         AND ai_attempts < ?
         AND (expires_at IS NULL OR expires_at > ?)
         AND (
           body_fetched_at IS NOT NULL
           OR first_seen_at <= ?
           OR source NOT IN (SELECT id FROM sources WHERE kind = 'sina_weibo')
         )
       ORDER BY is_new DESC, COALESCE(published_at, first_seen_at) DESC, id DESC
       LIMIT ?`,
    )
    .all(maxAttempts, now, bodyDeadline, limit) as AiPendingDeal[];
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
     SET ai_title = ?, ai_summary = ?,
         tags = ?, proposed_tags = ?, entities = ?, ai_tags_at = ?,
         ai_model = ?, ai_at = ?, ai_attempts = 0
     WHERE id = ?`,
  ).run(
    enrichment.title,
    enrichment.summary,
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
              source
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

/* ------------------------------ 用户与登录 ------------------------------ */

interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  password_salt: string;
  created_at: string;
  last_login_at: string | null;
  disabled: number;
  ai_quota_date: string | null;
  ai_quota_used: number;
  invite_code: string | null;
}

function mapAccountUser(row: UserRow): AccountUser {
  return {
    id: row.id,
    email: row.email,
    createdAt: row.created_at,
  };
}

/** 以 Asia/Shanghai 为准的日期键，用于每日配额与推送限额。 */
export function todayKey(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

export interface StoredUserAuth {
  user: AccountUser;
  passwordHash: string;
  passwordSalt: string;
  disabled: boolean;
}

export function createUser(
  email: string,
  passwordHash: string,
  passwordSalt: string,
): AccountUser | null {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    const result = db
      .prepare(
        `INSERT INTO users (email, password_hash, password_salt, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(email.trim().toLowerCase(), passwordHash, passwordSalt, now);
    const row = db
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(Number(result.lastInsertRowid)) as UserRow | undefined;
    return row ? mapAccountUser(row) : null;
  } catch {
    return null;
  }
}

export function getUserAuthByEmail(email: string): StoredUserAuth | null {
  const row = getDb()
    .prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE')
    .get(email.trim().toLowerCase()) as UserRow | undefined;
  if (!row) return null;
  return {
    user: mapAccountUser(row),
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    disabled: row.disabled === 1,
  };
}

export function getUserById(id: number): AccountUser | null {
  const row = getDb()
    .prepare('SELECT * FROM users WHERE id = ?')
    .get(id) as UserRow | undefined;
  return row ? mapAccountUser(row) : null;
}

export function markUserLogin(id: number): void {
  getDb()
    .prepare('UPDATE users SET last_login_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id);
}

function mapAdminUser(row: {
  id: number;
  email: string;
  created_at: string;
  last_login_at: string | null;
  disabled: number;
  invite_code: string | null;
  ai_quota_date: string | null;
  ai_quota_used: number;
  subscription_count: number;
  channel_count: number;
}): AdminUser {
  return {
    id: row.id,
    email: row.email,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    disabled: row.disabled === 1,
    inviteCode: row.invite_code,
    aiQuotaUsed:
      row.ai_quota_date === todayKey() ? row.ai_quota_used : 0,
    subscriptionCount: row.subscription_count,
    channelCount: row.channel_count,
  };
}

const ADMIN_USER_SELECT = `
  SELECT u.id, u.email, u.created_at, u.last_login_at, u.disabled,
         u.invite_code, u.ai_quota_date, u.ai_quota_used,
         (SELECT COUNT(*) FROM subscriptions s WHERE s.user_id = u.id) AS subscription_count,
         (SELECT COUNT(*) FROM channels c WHERE c.user_id = u.id) AS channel_count
  FROM users u`;

export function listAdminUsers(): AdminUser[] {
  const rows = getDb()
    .prepare(`${ADMIN_USER_SELECT} ORDER BY u.id DESC LIMIT 500`)
    .all() as Parameters<typeof mapAdminUser>[0][];
  return rows.map(mapAdminUser);
}

export interface AdminUserQuery {
  query?: string;
  status?: 'all' | 'active' | 'disabled';
  limit: number;
  offset: number;
}

export function searchAdminUsers(input: AdminUserQuery): {
  users: AdminUser[];
  total: number;
} {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (input.query?.trim()) {
    conditions.push('u.email LIKE ?');
    params.push(`%${input.query.trim()}%`);
  }
  if (input.status === 'active') conditions.push('u.disabled = 0');
  if (input.status === 'disabled') conditions.push('u.disabled = 1');

  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const db = getDb();
  const total = (
    db
      .prepare(`SELECT COUNT(*) AS count FROM users u${where}`)
      .get(...params) as { count: number }
  ).count;
  const rows = db
    .prepare(
      `${ADMIN_USER_SELECT}${where} ORDER BY u.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, input.limit, input.offset) as Parameters<
    typeof mapAdminUser
  >[0][];

  return { users: rows.map(mapAdminUser), total };
}

export function getAdminUserDetail(
  id: number,
  aiQuotaLimit: number,
): AdminUserDetail | null {
  const row = getDb()
    .prepare(`${ADMIN_USER_SELECT} WHERE u.id = ?`)
    .get(id) as Parameters<typeof mapAdminUser>[0] | undefined;
  if (!row) return null;

  return {
    user: mapAdminUser(row),
    aiQuotaLimit,
    subscriptions: listSubscriptions(id),
    channels: listChannels(id),
    deliveries: listUserDeliveries(id, 10),
  };
}

export function updateUserEmail(id: number, email: string): boolean {
  try {
    return (
      getDb()
        .prepare('UPDATE users SET email = ? WHERE id = ?')
        .run(email.trim().toLowerCase(), id).changes > 0
    );
  } catch {
    return false;
  }
}

export function updateUserPassword(
  id: number,
  hash: string,
  salt: string,
): void {
  getDb()
    .prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?')
    .run(hash, salt, id);
}

export function deleteUserSessions(userId: number): void {
  getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function deleteUserAccount(id: number): boolean {
  return getDb().prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0;
}

/* ------------------------------ 邀请码 ------------------------------ */

interface InviteCodeRow {
  id: number;
  code: string;
  max_uses: number;
  used_count: number;
  expires_at: string | null;
  disabled: number;
  created_at: string;
}

function mapInviteCode(row: InviteCodeRow): InviteCode {
  return {
    id: row.id,
    code: row.code,
    maxUses: row.max_uses,
    usedCount: row.used_count,
    expiresAt: row.expires_at,
    disabled: row.disabled === 1,
    createdAt: row.created_at,
  };
}

export function listInviteCodes(): InviteCode[] {
  const rows = getDb()
    .prepare('SELECT * FROM invite_codes ORDER BY id DESC LIMIT 500')
    .all() as InviteCodeRow[];
  return rows.map(mapInviteCode);
}

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomInviteCode(length = 8): string {
  let code = '';
  for (let index = 0; index < length; index += 1) {
    code += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)];
  }
  return code;
}

export function createInviteCodes(input: {
  count: number;
  maxUses: number;
  expiresAt: string | null;
  code?: string;
}): InviteCode[] {
  const db = getDb();
  const now = new Date().toISOString();
  const created: InviteCode[] = [];

  const run = db.transaction(() => {
    for (let index = 0; index < input.count; index += 1) {
      const code = input.code
        ? input.code
        : randomInviteCode();

      try {
        const result = db
          .prepare(
            `INSERT INTO invite_codes (code, max_uses, expires_at, created_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(code, input.maxUses, input.expiresAt, now);
        const row = db
          .prepare('SELECT * FROM invite_codes WHERE id = ?')
          .get(Number(result.lastInsertRowid)) as InviteCodeRow;
        created.push(mapInviteCode(row));
      } catch {
        // 自定义邀请码重复时跳过；自动生成的码冲突概率极低。
        if (input.code) break;
      }
    }
  });

  run();
  return created;
}

export function setInviteCodeDisabled(id: number, disabled: boolean): boolean {
  return (
    getDb()
      .prepare('UPDATE invite_codes SET disabled = ? WHERE id = ?')
      .run(disabled ? 1 : 0, id).changes > 0
  );
}

export function deleteInviteCode(id: number): boolean {
  return (
    getDb()
      .prepare('DELETE FROM invite_codes WHERE id = ? AND used_count = 0')
      .run(id).changes > 0
  );
}

export type CreateUserResult =
  | { user: AccountUser }
  | {
      error:
        | 'EMAIL_EXISTS'
        | 'INVITE_INVALID'
        | 'INVITE_DISABLED'
        | 'INVITE_EXPIRED'
        | 'INVITE_EXHAUSTED';
    };

export interface RegisterInvite {
  code: string;
  consume: boolean;
}

/** 创建用户并在同一事务内校验/扣减邀请码，避免并发超用。 */
export function createUserWithInvite(
  email: string,
  passwordHash: string,
  passwordSalt: string,
  invite: RegisterInvite | null,
): CreateUserResult {
  const db = getDb();
  const now = new Date().toISOString();

  const run = db.transaction((): CreateUserResult => {
    const existing = db
      .prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE')
      .get(email) as { id: number } | undefined;
    if (existing) return { error: 'EMAIL_EXISTS' };

    if (invite?.consume) {
      const row = db
        .prepare('SELECT * FROM invite_codes WHERE code = ? COLLATE NOCASE')
        .get(invite.code) as InviteCodeRow | undefined;
      if (!row) return { error: 'INVITE_INVALID' };
      if (row.disabled === 1) return { error: 'INVITE_DISABLED' };
      if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
        return { error: 'INVITE_EXPIRED' };
      }
      if (row.max_uses > 0 && row.used_count >= row.max_uses) {
        return { error: 'INVITE_EXHAUSTED' };
      }
      db.prepare(
        'UPDATE invite_codes SET used_count = used_count + 1 WHERE id = ?',
      ).run(row.id);
    }

    const result = db
      .prepare(
        `INSERT INTO users
           (email, password_hash, password_salt, created_at, invite_code)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        email.trim().toLowerCase(),
        passwordHash,
        passwordSalt,
        now,
        invite?.code ?? null,
      );
    const row = db
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(Number(result.lastInsertRowid)) as UserRow;
    return { user: mapAccountUser(row) };
  });

  return run();
}

export function updateSubscriptionKeyword(
  userId: number,
  id: number,
  keyword: string,
): boolean {
  try {
    return (
      getDb()
        .prepare(
          'UPDATE subscriptions SET keyword = ?, updated_at = ? WHERE id = ? AND user_id = ?',
        )
        .run(keyword.trim(), new Date().toISOString(), id, userId).changes > 0
    );
  } catch {
    return false;
  }
}

export function setUserDisabled(id: number, disabled: boolean): void {
  getDb()
    .prepare('UPDATE users SET disabled = ? WHERE id = ?')
    .run(disabled ? 1 : 0, id);
}

/* ------------------------------ 会话 ------------------------------ */

export function createUserSession(
  tokenHash: string,
  userId: number,
  expiresAt: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(tokenHash, userId, new Date().toISOString(), expiresAt);
}

export function getUserBySession(tokenHash: string): AccountUser | null {
  const db = getDb();
  const now = new Date().toISOString();
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0`,
    )
    .get(tokenHash, now) as UserRow | undefined;
  return row ? mapAccountUser(row) : null;
}

export function deleteUserSession(tokenHash: string): void {
  getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

export function pruneExpiredSessions(): void {
  getDb()
    .prepare('DELETE FROM sessions WHERE expires_at <= ?')
    .run(new Date().toISOString());
}

/* ------------------------------ AI 搜索每日配额 ------------------------------ */

export function getAiQuota(userId: number, limit: number): AiQuota {
  const row = getDb()
    .prepare('SELECT ai_quota_date, ai_quota_used FROM users WHERE id = ?')
    .get(userId) as
    | { ai_quota_date: string | null; ai_quota_used: number }
    | undefined;
  const date = todayKey();
  const used =
    row && row.ai_quota_date === date ? row.ai_quota_used : 0;
  return { limit, used, date };
}

/** 扣减一次 AI 搜索次数；limit 为 0 表示不限制。 */
export function consumeAiQuota(
  userId: number,
  limit: number,
): { ok: boolean; quota: AiQuota } {
  const db = getDb();
  const date = todayKey();

  const run = db.transaction(() => {
    const row = db
      .prepare('SELECT ai_quota_date, ai_quota_used FROM users WHERE id = ?')
      .get(userId) as
      | { ai_quota_date: string | null; ai_quota_used: number }
      | undefined;
    if (!row) return { ok: false, quota: { limit, used: 0, date } };

    let used = row.ai_quota_date === date ? row.ai_quota_used : 0;
    if (limit > 0 && used >= limit) {
      return { ok: false, quota: { limit, used, date } };
    }

    used += 1;
    db.prepare(
      'UPDATE users SET ai_quota_date = ?, ai_quota_used = ? WHERE id = ?',
    ).run(date, used, userId);
    return { ok: true, quota: { limit, used, date } };
  });

  return run();
}

/* ------------------------------ 订阅关键词 ------------------------------ */

interface SubscriptionRow {
  id: number;
  keyword: string;
  enabled: number;
  created_at: string;
}

export function listSubscriptions(userId: number): UserSubscription[] {
  const rows = getDb()
    .prepare(
      `SELECT id, keyword, enabled, created_at FROM subscriptions
       WHERE user_id = ? ORDER BY id DESC`,
    )
    .all(userId) as SubscriptionRow[];

  return rows.map((row) => ({
    id: row.id,
    keyword: row.keyword,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  }));
}

export function countSubscriptions(userId: number): number {
  return (
    getDb()
      .prepare('SELECT COUNT(*) AS count FROM subscriptions WHERE user_id = ?')
      .get(userId) as { count: number }
  ).count;
}

/** 新增订阅；重复关键词返回 null。 */
export function addSubscription(
  userId: number,
  keyword: string,
): UserSubscription | null {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    const result = db
      .prepare(
        `INSERT INTO subscriptions (user_id, keyword, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(userId, keyword.trim(), now, now);
    return {
      id: Number(result.lastInsertRowid),
      keyword: keyword.trim(),
      enabled: true,
      createdAt: now,
    };
  } catch {
    return null;
  }
}

export function setSubscriptionEnabled(
  userId: number,
  id: number,
  enabled: boolean,
): boolean {
  return (
    getDb()
      .prepare(
        'UPDATE subscriptions SET enabled = ?, updated_at = ? WHERE id = ? AND user_id = ?',
      )
      .run(enabled ? 1 : 0, new Date().toISOString(), id, userId).changes > 0
  );
}

export function deleteSubscription(userId: number, id: number): boolean {
  return (
    getDb()
      .prepare('DELETE FROM subscriptions WHERE id = ? AND user_id = ?')
      .run(id, userId).changes > 0
  );
}

/* ------------------------------ 推送渠道 ------------------------------ */

interface ChannelRow {
  id: number;
  user_id: number;
  kind: string;
  name: string;
  webhook: string;
  secret: string;
  channel_key: string;
  enabled: number;
  created_at: string;
}

function mapChannel(row: ChannelRow): UserChannel {
  return {
    id: row.id,
    kind: row.kind as ChannelKind,
    name: row.name,
    webhook: row.webhook,
    key: '',
    enabled: row.enabled === 1,
    configured:
      row.kind === 'bark'
        ? Boolean(row.channel_key || row.webhook)
        : Boolean(row.webhook),
    createdAt: row.created_at,
  };
}

const CHANNEL_COLUMNS =
  'id, user_id, kind, name, webhook, secret, channel_key, enabled, created_at';

export function listChannels(userId: number): UserChannel[] {
  const rows = getDb()
    .prepare(
      `SELECT ${CHANNEL_COLUMNS} FROM channels
       WHERE user_id = ? ORDER BY id DESC`,
    )
    .all(userId) as ChannelRow[];
  return rows.map(mapChannel);
}

export function countChannelsByKind(userId: number, kind: string): number {
  return (
    getDb()
      .prepare(
        'SELECT COUNT(*) AS count FROM channels WHERE user_id = ? AND kind = ?',
      )
      .get(userId, kind) as { count: number }
  ).count;
}

export interface ChannelSecretRow {
  id: number;
  userId: number;
  kind: ChannelKind;
  name: string;
  webhook: string;
  secret: string;
  key: string;
  enabled: boolean;
}

function toSecretRow(row: ChannelRow): ChannelSecretRow {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind as ChannelKind,
    name: row.name,
    webhook: row.webhook,
    secret: row.secret,
    key: row.channel_key,
    enabled: row.enabled === 1,
  };
}

export function addChannel(
  userId: number,
  input: {
    kind: ChannelKind;
    name: string;
    webhook: string;
    secret: string;
    key: string;
  },
): UserChannel | null {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO channels
         (user_id, kind, name, webhook, secret, channel_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      userId,
      input.kind,
      input.name,
      input.webhook,
      input.secret,
      input.key,
      now,
      now,
    );

  const row = db
    .prepare(`SELECT ${CHANNEL_COLUMNS} FROM channels WHERE id = ?`)
    .get(Number(result.lastInsertRowid)) as ChannelRow;
  return mapChannel(row);
}

/** 更新渠道；secret/key 传空字符串表示保持原值。 */
export function updateChannel(
  userId: number,
  id: number,
  patch: {
    name?: string;
    enabled?: boolean;
    webhook?: string;
    secret?: string;
    key?: string;
  },
): boolean {
  const db = getDb();
  const current = db
    .prepare(
      `SELECT ${CHANNEL_COLUMNS} FROM channels WHERE id = ? AND user_id = ?`,
    )
    .get(id, userId) as ChannelRow | undefined;
  if (!current) return false;

  db.prepare(
    `UPDATE channels
     SET name = ?, enabled = ?, webhook = ?, secret = ?, channel_key = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`,
  ).run(
    patch.name ?? current.name,
    patch.enabled === undefined
      ? current.enabled
      : patch.enabled
        ? 1
        : 0,
    patch.webhook ?? current.webhook,
    patch.secret ? patch.secret : current.secret,
    patch.key ? patch.key : current.channel_key,
    new Date().toISOString(),
    id,
    userId,
  );
  return true;
}

export function deleteChannel(userId: number, id: number): boolean {
  return (
    getDb()
      .prepare('DELETE FROM channels WHERE id = ? AND user_id = ?')
      .run(id, userId).changes > 0
  );
}

export function getChannelSecret(
  userId: number,
  id: number,
): ChannelSecretRow | null {
  const row = getDb()
    .prepare(
      `SELECT ${CHANNEL_COLUMNS} FROM channels WHERE id = ? AND user_id = ?`,
    )
    .get(id, userId) as ChannelRow | undefined;
  return row ? toSecretRow(row) : null;
}

/* ------------------------------ 关键词匹配与投递 ------------------------------ */

interface MatchDealRow {
  id: number;
  title: string;
  ai_title: string | null;
  ai_summary: string | null;
  description: string;
  tags: string | null;
  proposed_tags: string | null;
  expires_at: string | null;
  link: string;
}

export interface PendingDelivery {
  id: number;
  userId: number;
  subscriptionId: number;
  channelId: number;
  dealId: number;
  attempts: number;
  channelKind: ChannelKind;
  channelName: string;
  webhook: string;
  secret: string;
  channelKey: string;
  dealTitle: string;
  dealLink: string;
  keyword: string;
  tags: string[];
  createdAt: string;
}

export interface DealDetail {
  id: number;
  title: string;
  description: string;
  summary: string;
  value: string;
  action: string;
  tags: string[];
  source: string;
  link: string;
  publishedAt: string | null;
  expiresAt: string | null;
}

export interface DigestChannelTarget {
  userId: number;
  channelId: number;
  kind: ChannelKind;
  name: string;
  webhook: string;
  secret: string;
  channelKey: string;
}

export interface PendingDigest {
  id: number;
  userId: number;
  channelId: number;
  kind: 'overflow' | 'site';
  token: string;
  digestDate: string;
  title: string;
  lines: string[];
  items: DigestItem[];
  attempts: number;
  channelKind: ChannelKind;
  channelName: string;
  webhook: string;
  secret: string;
  channelKey: string;
}

export interface PublicDigestDeal {
  id: number;
  title: string;
  source: string;
  tags: string[];
  expiresAt: string | null;
  firstSeenAt: string;
}

export interface RelatedDeal {
  id: number;
  title: string;
  source: string;
}

export interface SiteDigestStats {
  newCount: number;
  activeCount: number;
  topTags: string[];
}

interface DealDetailRow {
  id: number;
  title: string;
  description: string;
  ai_title: string | null;
  ai_summary: string | null;
  ai_value: string | null;
  ai_action: string | null;
  tags: string | null;
  source: string;
  link: string;
  published_at: string | null;
  expires_at: string | null;
}

export function getDealById(id: number): DealDetail | null {
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = getDb()
    .prepare(
      `SELECT id, title, description, ai_title, ai_summary, ai_value, ai_action,
              tags, source, link, published_at, expires_at
       FROM deals WHERE id = ?`,
    )
    .get(id) as DealDetailRow | undefined;
  if (!row) return null;

  return {
    id: row.id,
    title: (row.ai_title || row.title).trim(),
    description: (row.description ?? '').trim(),
    summary: (row.ai_summary ?? '').trim(),
    value: (row.ai_value ?? '').trim(),
    action: (row.ai_action ?? '').trim(),
    tags: parseStoredTags(row.tags),
    source: row.source,
    link: row.link,
    publishedAt: row.published_at,
    expiresAt: row.expires_at,
  };
}

/** 新优惠打完标签后，按用户关键词生成待投递记录（幂等）。 */
export function matchDealToSubscriptions(dealId: number): number {
  const db = getDb();
  const deal = db
    .prepare(
      `SELECT id, title, ai_title, ai_summary, description, tags,
              proposed_tags, expires_at, link
       FROM deals
       WHERE id = ?
         AND EXISTS (
           SELECT 1 FROM sources s
           WHERE s.id = deals.source AND s.state = 'active' AND s.enabled = 1
         )`,
    )
    .get(dealId) as MatchDealRow | undefined;
  if (!deal) return 0;
  if (deal.expires_at && Date.parse(deal.expires_at) <= Date.now()) return 0;

  const haystack = [
    deal.title,
    deal.ai_title ?? '',
    deal.ai_summary ?? '',
    deal.description,
    ...parseStoredTags(deal.tags),
    ...parseStoredTags(deal.proposed_tags),
  ]
    .join('\n')
    .toLowerCase();
  if (!haystack.trim()) return 0;

  const subs = db
    .prepare(
      `SELECT s.id, s.user_id, s.keyword
       FROM subscriptions s
       JOIN users u ON u.id = s.user_id
       WHERE s.enabled = 1 AND u.disabled = 0`,
    )
    .all() as { id: number; user_id: number; keyword: string }[];

  const matched = subs.filter((sub) =>
    haystack.includes(sub.keyword.trim().toLowerCase()),
  );
  if (matched.length === 0) return 0;

  // 同一用户多个关键词命中同一条优惠时只推送一次，取最早创建的关键词。
  const perUser = new Map<number, { id: number; user_id: number }>();
  for (const sub of matched) {
    const current = perUser.get(sub.user_id);
    if (!current || sub.id < current.id) {
      perUser.set(sub.user_id, { id: sub.id, user_id: sub.user_id });
    }
  }
  const uniqueMatches = [...perUser.values()];

  const userIds = uniqueMatches.map((sub) => sub.user_id);
  const channels = db
    .prepare(
      `SELECT id, user_id FROM channels
       WHERE enabled = 1 AND user_id IN (${userIds.map(() => '?').join(', ')})`,
    )
    .all(...userIds) as { id: number; user_id: number }[];

  const byUser = new Map<number, number[]>();
  for (const channel of channels) {
    const list = byUser.get(channel.user_id) ?? [];
    list.push(channel.id);
    byUser.set(channel.user_id, list);
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO deliveries
       (user_id, subscription_id, channel_id, deal_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  let created = 0;

  const write = db.transaction(() => {
    for (const sub of uniqueMatches) {
      for (const channelId of byUser.get(sub.user_id) ?? []) {
        created += insert.run(
          sub.user_id,
          sub.id,
          channelId,
          deal.id,
          now,
        ).changes;
      }
    }
  });
  write();

  return created;
}

export function listPendingDeliveries(limit = 50): PendingDelivery[] {
  const rows = getDb()
    .prepare(
      `SELECT d.id, d.user_id, d.subscription_id, d.channel_id, d.deal_id,
              d.attempts, d.created_at, c.kind, c.name AS channel_name,
              c.webhook, c.secret, c.channel_key, s.keyword,
              COALESCE(NULLIF(TRIM(deals.ai_title), ''), deals.title) AS deal_title,
              deals.link AS deal_link, deals.tags
       FROM deliveries d
       JOIN subscriptions s ON s.id = d.subscription_id AND s.enabled = 1
       JOIN channels c ON c.id = d.channel_id AND c.enabled = 1
       JOIN users u ON u.id = d.user_id AND u.disabled = 0
       JOIN deals ON deals.id = d.deal_id
       WHERE d.status = 'pending' AND d.attempts < 3
         AND (deals.expires_at IS NULL OR deals.expires_at > ?)
       ORDER BY d.id ASC
       LIMIT ?`,
    )
    .all(new Date().toISOString(), limit) as {
    id: number;
    user_id: number;
    subscription_id: number;
    channel_id: number;
    deal_id: number;
    attempts: number;
    created_at: string;
    kind: string;
    channel_name: string;
    webhook: string;
    secret: string;
    channel_key: string;
    keyword: string;
    deal_title: string;
    deal_link: string;
    tags: string | null;
  }[];

  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    subscriptionId: row.subscription_id,
    channelId: row.channel_id,
    dealId: row.deal_id,
    attempts: row.attempts,
    channelKind: row.kind as ChannelKind,
    channelName: row.channel_name,
    webhook: row.webhook,
    secret: row.secret,
    channelKey: row.channel_key,
    dealTitle: row.deal_title,
    dealLink: row.deal_link,
    keyword: row.keyword,
    tags: parseStoredTags(row.tags),
    createdAt: row.created_at,
  }));
}

export function countUserPushesToday(userId: number): number {
  return (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS count FROM deliveries
         WHERE user_id = ? AND status = 'sent' AND sent_at >= ?`,
      )
      .get(
        userId,
        new Date(`${todayKey()}T00:00:00+08:00`).toISOString(),
      ) as { count: number }
  ).count;
}

export function markDeliverySent(id: number): void {
  getDb()
    .prepare(
      "UPDATE deliveries SET status = 'sent', sent_at = ?, error = NULL WHERE id = ?",
    )
    .run(new Date().toISOString(), id);
}

export function markDeliveryFailed(id: number, error: string): void {
  getDb()
    .prepare(
      `UPDATE deliveries
       SET attempts = attempts + 1,
           status = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE 'pending' END,
           error = ?
       WHERE id = ?`,
    )
    .run(error.slice(0, 300), id);
}

export function listUserDeliveries(
  userId: number,
  limit = 50,
): DeliveryRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT d.id, d.deal_id, d.status, d.error, d.created_at, d.sent_at,
              s.keyword, c.name AS channel_name, c.kind,
              COALESCE(NULLIF(TRIM(deals.ai_title), ''), deals.title) AS title,
              deals.link
       FROM deliveries d
       JOIN subscriptions s ON s.id = d.subscription_id
       JOIN channels c ON c.id = d.channel_id
       JOIN deals ON deals.id = d.deal_id
       WHERE d.user_id = ?
       ORDER BY d.id DESC
       LIMIT ?`,
    )
    .all(userId, Math.min(Math.max(limit, 1), 100)) as {
    id: number;
    deal_id: number;
    status: string;
    error: string | null;
    created_at: string;
    sent_at: string | null;
    keyword: string;
    channel_name: string;
    kind: string;
    title: string;
    link: string;
  }[];

  return rows.map((row) => ({
    id: row.id,
    dealId: row.deal_id,
    title: row.title,
    link: row.link,
    keyword: row.keyword,
    channelName: row.channel_name,
    channelKind: row.kind as ChannelKind,
    status: row.status as DeliveryRecord['status'],
    error: row.error,
    createdAt: row.created_at,
    sentAt: row.sent_at,
  }));
}

/* ------------------------------ 每日汇总 ------------------------------ */

export interface SiteDigestDeal {
  id: number;
  title: string;
  link: string;
  tags: string[];
}

function visibleSourceIds(): string[] {
  return listSources()
    .filter((source) => source.state === 'active')
    .map((source) => source.id);
}

function todayStartIso(): string {
  return new Date(`${todayKey()}T00:00:00+08:00`).toISOString();
}

/** 有启用订阅且至少绑定一个启用渠道的用户渠道列表。 */
export function listDigestRecipients(): DigestChannelTarget[] {
  const rows = getDb()
    .prepare(
      `SELECT c.user_id, c.id AS channel_id, c.kind, c.name,
              c.webhook, c.secret, c.channel_key
       FROM channels c
       JOIN users u ON u.id = c.user_id AND u.disabled = 0
       WHERE c.enabled = 1
         AND EXISTS (
           SELECT 1 FROM subscriptions s
           WHERE s.user_id = u.id AND s.enabled = 1
         )
       ORDER BY c.user_id ASC, c.id ASC`,
    )
    .all() as {
    user_id: number;
    channel_id: number;
    kind: string;
    name: string;
    webhook: string;
    secret: string;
    channel_key: string;
  }[];

  return rows.map((row) => ({
    userId: row.user_id,
    channelId: row.channel_id,
    kind: row.kind as ChannelKind,
    name: row.name,
    webhook: row.webhook,
    secret: row.secret,
    channelKey: row.channel_key,
  }));
}

export function insertDailyDigest(input: {
  userId: number;
  channelId: number;
  kind: 'overflow' | 'site';
  date: string;
  title: string;
  lines: string[];
  items: DigestItem[];
}): boolean {
  const token = randomBytes(12).toString('hex');
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO daily_digests
         (user_id, channel_id, kind, digest_date, token, title, lines, items,
          item_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.userId,
      input.channelId,
      input.kind,
      input.date,
      token,
      input.title,
      JSON.stringify(input.lines),
      JSON.stringify(input.items),
      input.items.length,
      new Date().toISOString(),
    );
  return result.changes > 0;
}

function parseDigestLines(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (line): line is string => typeof line === 'string' && Boolean(line.trim()),
    );
  } catch {
    return [];
  }
}

function parseDigestItems(value: string): DigestItem[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const record = item as Record<string, unknown>;
        const dealId = Number(record.dealId);
        const title = typeof record.title === 'string' ? record.title : '';
        const url = typeof record.url === 'string' ? record.url : '';
        if (!Number.isInteger(dealId) || dealId <= 0 || !title || !url) {
          return null;
        }
        return { dealId, title, url };
      })
      .filter((item): item is DigestItem => Boolean(item));
  } catch {
    return [];
  }
}

export function listPendingDigests(limit = 30): PendingDigest[] {
  const rows = getDb()
    .prepare(
      `SELECT g.id, g.user_id, g.channel_id, g.kind, g.token, g.digest_date,
              g.title, g.lines, g.items, g.attempts,
              c.kind AS channel_kind, c.name AS channel_name,
              c.webhook, c.secret, c.channel_key
       FROM daily_digests g
       JOIN channels c ON c.id = g.channel_id AND c.enabled = 1
       JOIN users u ON u.id = g.user_id AND u.disabled = 0
       WHERE g.status = 'pending' AND g.attempts < 3
       ORDER BY g.id ASC
       LIMIT ?`,
    )
    .all(Math.min(Math.max(limit, 1), 200)) as {
    id: number;
    user_id: number;
    channel_id: number;
    kind: string;
    token: string;
    digest_date: string;
    title: string;
    lines: string;
    items: string;
    attempts: number;
    channel_kind: string;
    channel_name: string;
    webhook: string;
    secret: string;
    channel_key: string;
  }[];

  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    channelId: row.channel_id,
    kind: row.kind === 'site' ? 'site' : 'overflow',
    token: row.token,
    digestDate: row.digest_date,
    title: row.title,
    lines: parseDigestLines(row.lines),
    items: parseDigestItems(row.items),
    attempts: row.attempts,
    channelKind: row.channel_kind as ChannelKind,
    channelName: row.channel_name,
    webhook: row.webhook,
    secret: row.secret,
    channelKey: row.channel_key,
  }));
}

export function markDigestSent(id: number): void {
  getDb()
    .prepare(
      "UPDATE daily_digests SET status = 'sent', sent_at = ?, error = NULL WHERE id = ?",
    )
    .run(new Date().toISOString(), id);
}

export function markDigestFailed(id: number, error: string): void {
  getDb()
    .prepare(
      `UPDATE daily_digests
       SET attempts = attempts + 1,
           status = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE 'pending' END,
           error = ?
       WHERE id = ?`,
    )
    .run(error.slice(0, 300), id);
}

export function markDeliveriesDigested(
  userId: number,
  channelId: number,
  dealIds: number[],
): void {
  if (dealIds.length === 0) return;
  getDb()
    .prepare(
      `UPDATE deliveries SET status = 'digested'
       WHERE user_id = ? AND channel_id = ? AND status = 'pending'
         AND deal_id IN (${dealIds.map(() => '?').join(', ')})`,
    )
    .run(userId, channelId, ...dealIds);
}

export function markDeliveriesSkipped(
  userId: number,
  channelId: number,
  dealIds: number[],
): void {
  if (dealIds.length === 0) return;
  getDb()
    .prepare(
      `UPDATE deliveries SET status = 'skipped'
       WHERE user_id = ? AND channel_id = ? AND status = 'pending'
         AND deal_id IN (${dealIds.map(() => '?').join(', ')})`,
    )
    .run(userId, channelId, ...dealIds);
}

export function skipUserPendingDeliveries(userId: number): void {
  getDb()
    .prepare(
      "UPDATE deliveries SET status = 'skipped' WHERE user_id = ? AND status = 'pending'",
    )
    .run(userId);
}

/** 跨天、已过期或历史重复的待投递条目直接跳过，避免补推旧内容或重复推送。 */
export function skipStalePendingDeliveries(): number {
  const db = getDb();
  const now = new Date().toISOString();
  const stale = db
    .prepare(
      `UPDATE deliveries SET status = 'skipped'
       WHERE status = 'pending'
         AND (
           created_at < ?
           OR deal_id IN (
             SELECT id FROM deals
             WHERE expires_at IS NOT NULL AND expires_at <= ?
           )
           OR deal_id IN (
             SELECT d.id FROM deals d
             WHERE NOT EXISTS (
               SELECT 1 FROM sources s
               WHERE s.id = d.source AND s.state = 'active' AND s.enabled = 1
             )
           )
         )`,
    )
    .run(todayStartIso(), now).changes;

  // 同一用户、同一渠道、同一优惠只保留最早的一条待投递记录。
  const duplicated = db
    .prepare(
      `UPDATE deliveries SET status = 'skipped'
       WHERE status = 'pending'
         AND id NOT IN (
           SELECT MIN(id) FROM deliveries
           WHERE status = 'pending'
           GROUP BY user_id, channel_id, deal_id
         )`,
    )
    .run().changes;

  return stale + duplicated;
}

export function getSiteDigestStats(): SiteDigestStats {
  const sources = visibleSourceIds();
  if (sources.length === 0) {
    return { newCount: 0, activeCount: 0, topTags: [] };
  }

  const placeholders = sources.map(() => '?').join(', ');
  const db = getDb();
  const now = new Date().toISOString();
  const start = todayStartIso();

  const activeCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM deals
         WHERE (expires_at IS NULL OR expires_at > ?)
           AND source IN (${placeholders})`,
      )
      .get(now, ...sources) as { count: number }
  ).count;

  const newCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM deals
         WHERE first_seen_at >= ?
           AND (expires_at IS NULL OR expires_at > ?)
           AND source IN (${placeholders})`,
      )
      .get(start, now, ...sources) as { count: number }
  ).count;

  const topTags = (
    db
      .prepare(
        `SELECT json_each.value AS tag, COUNT(*) AS count
         FROM deals d, json_each(d.tags)
         WHERE d.first_seen_at >= ?
           AND (d.expires_at IS NULL OR d.expires_at > ?)
           AND d.source IN (${placeholders})
           AND length(json_each.value) BETWEEN 2 AND 12
         GROUP BY json_each.value
         ORDER BY count DESC, tag ASC
         LIMIT 5`,
      )
      .all(start, now, ...sources) as { tag: string; count: number }[]
  ).map((row) => row.tag);

  return { newCount, activeCount, topTags };
}

export function listTodayDealsForDigest(limit = 40): SiteDigestDeal[] {
  const sources = visibleSourceIds();
  if (sources.length === 0) return [];

  const rows = getDb()
    .prepare(
      `SELECT id, COALESCE(NULLIF(TRIM(ai_title), ''), title) AS title, link, tags
       FROM deals
       WHERE first_seen_at >= ?
         AND (expires_at IS NULL OR expires_at > ?)
         AND source IN (${sources.map(() => '?').join(', ')})
       ORDER BY first_seen_at DESC, id DESC
       LIMIT ?`,
    )
    .all(
      todayStartIso(),
      new Date().toISOString(),
      ...sources,
      Math.min(Math.max(limit, 1), 200),
    ) as { id: number; title: string; link: string; tags: string | null }[];

  return rows.map((row) => ({
    id: row.id,
    title: row.title.trim(),
    link: row.link,
    tags: parseStoredTags(row.tags),
  }));
}

export function getDigestLastRun(kind: 'overflow' | 'site'): string | null {
  return getSetting(`digest:last:${kind}`);
}

export function setDigestLastRun(kind: 'overflow' | 'site', date: string): void {
  setSetting(`digest:last:${kind}`, date);
}

export function pruneDailyDigests(days = 30): void {
  const cutoff = new Date(
    Date.now() - Math.min(Math.max(days, 1), 365) * 24 * 60 * 60 * 1000,
  ).toISOString();
  getDb()
    .prepare('DELETE FROM daily_digests WHERE created_at < ?')
    .run(cutoff);
}

function parseJsonArray<T>(value: string): T[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function getPublicDigest(date: string): PublicDigest | null {
  const row = getDb()
    .prepare(
      `SELECT digest_date, title, stats, tags, groups
       FROM public_digests WHERE digest_date = ?`,
    )
    .get(date) as
    | {
        digest_date: string;
        title: string;
        stats: string;
        tags: string;
        groups: string;
      }
    | undefined;
  if (!row) return null;

  return {
    date: row.digest_date,
    title: row.title,
    stats: parseJsonArray<string>(row.stats),
    tags: parseJsonArray<{ tag: string; count: number }>(row.tags),
    groups: parseJsonArray<{
      tag: string;
      count: number;
      items: PublicDigest['groups'][number]['items'];
    }>(row.groups),
  };
}

export function savePublicDigest(digest: PublicDigest): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO public_digests
         (digest_date, title, stats, tags, groups, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(digest_date) DO UPDATE SET
         title = excluded.title,
         stats = excluded.stats,
         tags = excluded.tags,
         groups = excluded.groups,
         updated_at = excluded.updated_at`,
    )
    .run(
      digest.date,
      digest.title,
      JSON.stringify(digest.stats),
      JSON.stringify(digest.tags),
      JSON.stringify(digest.groups),
      now,
      now,
    );
}

/** 读取某天（北京时间）收录的优惠，用于生成公开汇总快照。 */
export function listDealsForPublicDigest(date: string): PublicDigestDeal[] {
  const start = new Date(`${date}T00:00:00+08:00`);
  if (Number.isNaN(start.getTime())) return [];
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  const rows = getDb()
    .prepare(
      `SELECT d.id, COALESCE(NULLIF(TRIM(d.ai_title), ''), d.title) AS title,
              d.source, d.tags, d.expires_at, d.first_seen_at
       FROM deals d
       JOIN sources s ON s.id = d.source AND s.enabled = 1 AND s.state = 'active'
       WHERE d.first_seen_at >= ? AND d.first_seen_at < ?
       ORDER BY d.first_seen_at DESC, d.id DESC
       LIMIT 1500`,
    )
    .all(start.toISOString(), end.toISOString()) as {
    id: number;
    title: string;
    source: string;
    tags: string | null;
    expires_at: string | null;
    first_seen_at: string;
  }[];

  return rows.map((row) => ({
    id: row.id,
    title: row.title.trim(),
    source: row.source,
    tags: parseStoredTags(row.tags),
    expiresAt: row.expires_at,
    firstSeenAt: row.first_seen_at,
  }));
}

export function getRelatedDeals(
  dealId: number,
  tags: string[],
  limit = 3,
): RelatedDeal[] {
  if (tags.length === 0) return [];

  const params: (string | number)[] = [
    dealId,
    new Date().toISOString(),
    ...tags,
  ];

  const rows = getDb()
    .prepare(
      `SELECT deals.id,
              COALESCE(NULLIF(TRIM(deals.ai_title), ''), deals.title) AS title,
              deals.source
       FROM deals
       JOIN sources s ON s.id = deals.source AND s.enabled = 1 AND s.state = 'active'
       WHERE deals.id != ?
         AND (deals.expires_at IS NULL OR deals.expires_at > ?)
         AND EXISTS (
           SELECT 1 FROM json_each(deals.tags) WHERE value IN (${tags
             .map(() => '?')
             .join(', ')})
         )
       ORDER BY deals.first_seen_at DESC, deals.id DESC
       LIMIT ?`,
    )
    .all(...params, Math.min(Math.max(limit, 1), 6)) as {
    id: number;
    title: string;
    source: string;
  }[];

  return rows.map((row) => ({
    id: row.id,
    title: row.title.trim(),
    source: row.source,
  }));
}


/* ------------------------------------------------------------------ *
 * 订阅向量匹配（关键词向量、文章向量与灰度日志）
 * ------------------------------------------------------------------ */

export interface KeywordVectorRecord {
  keyword: string;
  vector: Buffer;
  dims: number;
}

export interface DealVectorInput {
  id: number;
  title: string;
  ai_title: string | null;
  ai_summary: string | null;
  tags: string;
  description: string;
}

/** 需要补算向量的启用关键词（缺失或模型版本不一致）。 */
export function listKeywordsNeedingVector(
  model: string,
  limit = 200,
): string[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT LOWER(TRIM(s.keyword)) AS keyword
       FROM subscriptions s
       JOIN users u ON u.id = s.user_id AND u.disabled = 0
       LEFT JOIN keyword_vectors v
         ON v.keyword = LOWER(TRIM(s.keyword)) AND v.model = ?
       WHERE s.enabled = 1
         AND LENGTH(TRIM(s.keyword)) >= 2
         AND v.keyword IS NULL
       ORDER BY keyword ASC
       LIMIT ?`,
    )
    .all(model, Math.min(Math.max(limit, 1), 500)) as { keyword: string }[];

  return rows.map((row) => row.keyword);
}

/** 写入关键词向量，并同步订阅引用计数。 */
export function upsertKeywordVector(
  keyword: string,
  vector: Buffer,
  dims: number,
  model: string,
): void {
  const db = getDb();
  const normalized = keyword.trim().toLowerCase();
  const count = (
    db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM subscriptions s
         JOIN users u ON u.id = s.user_id AND u.disabled = 0
         WHERE s.enabled = 1 AND LOWER(TRIM(s.keyword)) = ?`,
      )
      .get(normalized) as { count: number }
  ).count;

  db.prepare(
    `INSERT INTO keyword_vectors
       (keyword, vector, dims, model, source_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(keyword) DO UPDATE SET
       vector = excluded.vector,
       dims = excluded.dims,
       model = excluded.model,
       source_count = excluded.source_count,
       updated_at = excluded.updated_at`,
  ).run(normalized, vector, dims, model, count, new Date().toISOString());
}

/** 读取指定模型的全部关键词向量，供内存缓存使用。 */
export function listKeywordVectors(model: string): KeywordVectorRecord[] {
  return getDb()
    .prepare(
      `SELECT keyword, vector, dims FROM keyword_vectors WHERE model = ?`,
    )
    .all(model) as KeywordVectorRecord[];
}

/** 刷新引用计数，并回收 30 天内无人使用的旧向量。 */
export function refreshKeywordVectorRefCounts(): void {
  const db = getDb();
  db.prepare(
    `UPDATE keyword_vectors
     SET source_count = (
       SELECT COUNT(*) FROM subscriptions s
       JOIN users u ON u.id = s.user_id AND u.disabled = 0
       WHERE s.enabled = 1 AND LOWER(TRIM(s.keyword)) = keyword_vectors.keyword
     )`,
  ).run();
  db.prepare(
    `DELETE FROM keyword_vectors
     WHERE source_count = 0 AND updated_at < ?`,
  ).run(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
}

/** 需要补算向量的文章：来源可见、未过期、最近入库。 */
export function listDealsNeedingVector(
  model: string,
  sinceIso: string,
  limit = 20,
): DealVectorInput[] {
  return getDb()
    .prepare(
      `SELECT d.id,
              d.title,
              d.ai_title,
              d.ai_summary,
              d.tags,
              d.description
       FROM deals d
       JOIN sources s ON s.id = d.source AND s.state = 'active' AND s.enabled = 1
       WHERE (d.expires_at IS NULL OR d.expires_at > ?)
         AND d.first_seen_at >= ?
         AND (d.vector_at IS NULL OR d.vector_model != ?)
       ORDER BY d.id DESC
       LIMIT ?`,
    )
    .all(
      new Date().toISOString(),
      sinceIso,
      model,
      Math.min(Math.max(limit, 1), 100),
    ) as DealVectorInput[];
}

export function saveDealVector(
  dealId: number,
  vector: Buffer,
  model: string,
): void {
  getDb()
    .prepare(
      `UPDATE deals SET vector = ?, vector_model = ?, vector_at = ? WHERE id = ?`,
    )
    .run(vector, model, new Date().toISOString(), dealId);
}

export function getDealVector(
  dealId: number,
): { vector: Buffer; model: string } | null {
  const row = getDb()
    .prepare(
      `SELECT vector, vector_model AS model FROM deals WHERE id = ? AND vector IS NOT NULL`,
    )
    .get(dealId) as { vector: Buffer; model: string } | undefined;
  return row ?? null;
}

export function listEnabledSubscriptions(): {
  id: number;
  user_id: number;
  keyword: string;
}[] {
  return getDb()
    .prepare(
      `SELECT s.id, s.user_id, s.keyword
       FROM subscriptions s
       JOIN users u ON u.id = s.user_id
       WHERE s.enabled = 1 AND u.disabled = 0`,
    )
    .all() as { id: number; user_id: number; keyword: string }[];
}

/** 按用户去重后写入订阅投递记录，返回新增行数。 */
export function insertVectorDeliveries(
  dealId: number,
  matches: { subscriptionId: number; userId: number }[],
): number {
  if (matches.length === 0) return 0;

  const db = getDb();
  const userIds = [...new Set(matches.map((item) => item.userId))];
  const channels = db
    .prepare(
      `SELECT id, user_id FROM channels
       WHERE enabled = 1 AND user_id IN (${userIds.map(() => '?').join(', ')})`,
    )
    .all(...userIds) as { id: number; user_id: number }[];

  const byUser = new Map<number, number[]>();
  for (const channel of channels) {
    const list = byUser.get(channel.user_id) ?? [];
    list.push(channel.id);
    byUser.set(channel.user_id, list);
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO deliveries
       (user_id, subscription_id, channel_id, deal_id, created_at)
     SELECT ?, ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM deliveries
       WHERE user_id = ? AND deal_id = ?
     )`,
  );
  const now = new Date().toISOString();
  let created = 0;

  const write = db.transaction(() => {
    for (const match of matches) {
      for (const channelId of byUser.get(match.userId) ?? []) {
        created += insert.run(
          match.userId,
          match.subscriptionId,
          channelId,
          dealId,
          now,
          match.userId,
          dealId,
        ).changes;
      }
    }
  });
  write();

  return created;
}

export function logVectorMatches(
  entries: {
    dealId: number;
    keyword: string;
    userId: number;
    score: number;
    pushed: boolean;
  }[],
): void {
  if (entries.length === 0) return;

  const insert = getDb().prepare(
    `INSERT OR IGNORE INTO vector_match_log
       (deal_id, keyword, user_id, score, pushed, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  const write = getDb().transaction(() => {
    for (const entry of entries) {
      insert.run(
        entry.dealId,
        entry.keyword,
        entry.userId,
        entry.score,
        entry.pushed ? 1 : 0,
        now,
      );
    }
  });
  write();
}

export function readVectorStats(): {
  keywords: number;
  deals: number;
  matchesToday: number;
  pushedToday: number;
} {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const keywordRow = db
    .prepare(`SELECT COUNT(*) AS count FROM keyword_vectors`)
    .get() as { count: number };
  const dealRow = db
    .prepare(`SELECT COUNT(*) AS count FROM deals WHERE vector IS NOT NULL`)
    .get() as { count: number };
  const logRow = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(pushed), 0) AS pushed
       FROM vector_match_log WHERE created_at >= ?`,
    )
    .get(`${today}T00:00:00.000Z`) as { count: number; pushed: number };

  return {
    keywords: keywordRow.count,
    deals: dealRow.count,
    matchesToday: logRow.count,
    pushedToday: logRow.pushed,
  };
}
