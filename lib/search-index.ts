import type Database from 'better-sqlite3';
import { buildSearchIndexText, buildLikePattern } from './search-text';
import type { SearchIndexStatus } from './types';

type Db = Database.Database;

export const SEARCH_INDEX_VERSION = '2';

const globalForSearch = globalThis as typeof globalThis & {
  __dailyDealsFtsAvailable?: boolean;
};

/** 生产环境下每个路由可能各自打包一份模块，标志位放在 globalThis 上共享。 */
function isFtsAvailable(): boolean {
  return globalForSearch.__dailyDealsFtsAvailable === true;
}

function setFtsAvailable(value: boolean): void {
  globalForSearch.__dailyDealsFtsAvailable = value;
}

export interface SearchCandidate {
  id: number;
  title: string;
  aiTitle: string | null;
  aiSummary: string | null;
  description: string;
  source: string;
  sourceName: string;
  category: string;
  expiresAt: string | null;
  publishedAt: string | null;
  firstSeenAt: string;
  rank: number;
}

export interface SearchScopeOptions {
  activeOnly: boolean;
  days: number | null;
  visibleSources: string[];
  limit: number;
}

interface DealIndexRow {
  id: number;
  title: string;
  ai_title: string | null;
  ai_summary: string | null;
  description: string | null;
  source_name: string | null;
}

function readSetting(db: Db, key: string): string | null {
  const row = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function writeSetting(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, new Date().toISOString());
}

function deleteRow(db: Db, id: number): void {
  db.prepare('DELETE FROM deals_fts WHERE rowid = ?').run(id);
}

function insertRow(
  db: Db,
  row: DealIndexRow,
  maxChars: number,
): void {
  const title = buildSearchIndexText(
    [row.title, row.ai_title].filter(Boolean).join(' '),
    maxChars,
  );
  const summary = buildSearchIndexText(row.ai_summary, maxChars);
  const description = buildSearchIndexText(
    [row.description, row.source_name].filter(Boolean).join(' '),
    maxChars,
  );

  db.prepare(
    'INSERT INTO deals_fts (rowid, title, summary, description) VALUES (?, ?, ?, ?)',
  ).run(row.id, title, summary, description);
}

export function indexDealById(
  db: Db,
  id: number,
  maxChars: number,
): void {
  if (!isFtsAvailable()) return;
  try {
    const row = db
      .prepare(
        `SELECT d.id, d.title, d.ai_title, d.ai_summary, d.description,
                COALESCE(s.name, d.source) AS source_name
         FROM deals d
         LEFT JOIN sources s ON s.id = d.source
         WHERE d.id = ?`,
      )
      .get(id) as DealIndexRow | undefined;

    deleteRow(db, id);
    if (row) insertRow(db, row, maxChars);
  } catch (error) {
    console.warn('[search-index] index deal failed', id, error);
  }
}

export function deleteDealIndex(db: Db, id: number): void {
  if (!isFtsAvailable()) return;
  try {
    deleteRow(db, id);
  } catch (error) {
    console.warn('[search-index] delete deal index failed', id, error);
  }
}

export function deleteDealIndexesForSource(
  db: Db,
  source: string,
): void {
  if (!isFtsAvailable()) return;
  try {
    db.prepare(
      'DELETE FROM deals_fts WHERE rowid IN (SELECT id FROM deals WHERE source = ?)',
    ).run(source);
  } catch (error) {
    console.warn('[search-index] delete source index failed', source, error);
  }
}

export function deleteDealIndexesForExpired(
  db: Db,
  nowIso: string,
): void {
  if (!isFtsAvailable()) return;
  try {
    db.prepare(
      `DELETE FROM deals_fts WHERE rowid IN (
         SELECT id FROM deals
         WHERE expires_at IS NOT NULL AND expires_at <= ?
       )`,
    ).run(nowIso);
  } catch (error) {
    console.warn('[search-index] delete expired index failed', error);
  }
}

export function deleteDealIndexesForRetention(
  db: Db,
  cutoffIso: string,
): void {
  if (!isFtsAvailable()) return;
  try {
    db.prepare(
      'DELETE FROM deals_fts WHERE rowid IN (SELECT id FROM deals WHERE first_seen_at < ?)',
    ).run(cutoffIso);
  } catch (error) {
    console.warn('[search-index] delete retained index failed', error);
  }
}

export function rebuildSearchIndex(db: Db, maxChars: number): number {
  db.exec('DELETE FROM deals_fts');

  const select = db.prepare(
    `SELECT d.id, d.title, d.ai_title, d.ai_summary, d.description,
            COALESCE(s.name, d.source) AS source_name
     FROM deals d
     LEFT JOIN sources s ON s.id = d.source
     WHERE d.id > ?
     ORDER BY d.id
     LIMIT 1000`,
  );

  let cursor = 0;
  let indexed = 0;

  for (;;) {
    const rows = select.all(cursor) as DealIndexRow[];
    if (rows.length === 0) break;

    db.exec('BEGIN');
    try {
      for (const row of rows) insertRow(db, row, maxChars);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    indexed += rows.length;
    cursor = rows[rows.length - 1].id;
  }

  const builtAt = new Date().toISOString();
  writeSetting(db, 'search_index_version', SEARCH_INDEX_VERSION);
  writeSetting(db, 'search_index_built_at', builtAt);

  return indexed;
}

export function ensureSearchIndex(
  db: Db,
  maxChars: number,
): boolean {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS deals_fts USING fts5(
        title,
        summary,
        description,
        tokenize = 'unicode61'
      )
    `);
  } catch (error) {
    console.warn(
      '[search-index] FTS5 unavailable, falling back to keyword scan',
      error,
    );
    setFtsAvailable(false);
    return false;
  }

  setFtsAvailable(true);
  const version = readSetting(db, 'search_index_version');
  const deals = (
    db.prepare('SELECT COUNT(*) AS count FROM deals').get() as {
      count: number;
    }
  ).count;
  const indexed = (
    db.prepare('SELECT COUNT(*) AS count FROM deals_fts').get() as {
      count: number;
    }
  ).count;

  if (version !== SEARCH_INDEX_VERSION || indexed !== deals) {
    const started = Date.now();
    const total = rebuildSearchIndex(db, maxChars);
    console.log(
      `[search-index] rebuilt rows=${total} ms=${Date.now() - started}`,
    );
  }

  return true;
}

export function readSearchIndexStatus(db: Db): SearchIndexStatus {
  try {
    const indexed = (
      db.prepare('SELECT COUNT(*) AS count FROM deals_fts').get() as {
        count: number;
      }
    ).count;
    const deals = (
      db.prepare('SELECT COUNT(*) AS count FROM deals').get() as {
        count: number;
      }
    ).count;

    setFtsAvailable(true);
    return {
      available: true,
      indexed,
      deals,
      version: readSetting(db, 'search_index_version'),
      builtAt: readSetting(db, 'search_index_built_at'),
    };
  } catch {
    return {
      available: false,
      indexed: 0,
      deals: 0,
      version: null,
      builtAt: null,
    };
  }
}

function buildScopeWhere(
  options: SearchScopeOptions,
  alias = 'd',
): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (options.activeOnly) {
    clauses.push(
      `(${alias}.expires_at IS NULL OR ${alias}.expires_at > ?)`,
    );
    params.push(new Date().toISOString());
  }

  if (options.days !== null) {
    const cutoff = new Date(
      Date.now() - options.days * 24 * 60 * 60 * 1000,
    ).toISOString();
    clauses.push(
      `COALESCE(${alias}.published_at, ${alias}.first_seen_at) >= ?`,
    );
    params.push(cutoff);
  }

  if (options.visibleSources.length > 0) {
    const placeholders = options.visibleSources.map(() => '?').join(', ');
    clauses.push(`${alias}.source IN (${placeholders})`);
    params.push(...options.visibleSources);
  } else {
    clauses.push('1 = 0');
  }

  return {
    sql: clauses.length > 0 ? `AND ${clauses.join(' AND ')}` : '',
    params,
  };
}

const CANDIDATE_COLUMNS = `
  d.id,
  d.title,
  d.ai_title,
  d.ai_summary,
  d.description,
  d.source,
  COALESCE(s.name, d.source) AS source_name,
  d.category,
  d.expires_at,
  d.published_at,
  d.first_seen_at
`;

interface RawSearchRow {
  id: number;
  title: string;
  ai_title: string | null;
  ai_summary: string | null;
  description: string | null;
  source: string;
  source_name: string | null;
  category: string;
  expires_at: string | null;
  published_at: string | null;
  first_seen_at: string;
  rank: number;
}

function mapSearchRow(row: RawSearchRow): SearchCandidate {
  return {
    id: row.id,
    title: row.title,
    aiTitle: row.ai_title,
    aiSummary: row.ai_summary,
    description: row.description ?? '',
    source: row.source,
    sourceName: row.source_name ?? row.source,
    category: row.category,
    expiresAt: row.expires_at,
    publishedAt: row.published_at,
    firstSeenAt: row.first_seen_at,
    rank: Number(row.rank),
  };
}

export function searchDealsByFts(
  db: Db,
  match: string,
  options: SearchScopeOptions,
): SearchCandidate[] | null {
  if (!isFtsAvailable()) return null;
  try {
    const scope = buildScopeWhere(options);
    const rows = db
      .prepare(
        `SELECT ${CANDIDATE_COLUMNS}, bm25(deals_fts, 5.0, 3.0, 1.0) AS rank
         FROM deals_fts
         JOIN deals d ON d.id = deals_fts.rowid
         LEFT JOIN sources s ON s.id = d.source
         WHERE deals_fts MATCH ?
           ${scope.sql}
         ORDER BY rank ASC
         LIMIT ?`,
      )
      .all(match, ...scope.params, Math.min(options.limit, 500)) as RawSearchRow[];

    return rows.map(mapSearchRow);
  } catch (error) {
    console.warn('[search-index] FTS query failed', error);
    return null;
  }
}

export function searchDealsByLike(
  db: Db,
  query: string,
  options: SearchScopeOptions,
): SearchCandidate[] {
  try {
    const scope = buildScopeWhere(options);
    const pattern = buildLikePattern(query);
    const rows = db
      .prepare(
        `SELECT ${CANDIDATE_COLUMNS}, 0 AS rank
         FROM deals d
         LEFT JOIN sources s ON s.id = d.source
         WHERE (
           d.title LIKE ? ESCAPE '\\'
           OR d.ai_title LIKE ? ESCAPE '\\'
           OR d.ai_summary LIKE ? ESCAPE '\\'
           OR d.description LIKE ? ESCAPE '\\'
           OR s.name LIKE ? ESCAPE '\\'
         )
         ${scope.sql}
         ORDER BY COALESCE(d.published_at, d.first_seen_at) DESC
         LIMIT ?`,
      )
      .all(
        pattern,
        pattern,
        pattern,
        pattern,
        pattern,
        ...scope.params,
        Math.min(options.limit, 500),
      ) as RawSearchRow[];

    return rows.map(mapSearchRow);
  } catch (error) {
    console.warn('[search-index] LIKE query failed', error);
    return [];
  }
}
