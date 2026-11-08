/** 来源标识由数据库动态维护，不再限制为固定枚举。 */
export type SourceId = string;

export type SourceKind = 'rss' | 'epic' | 'linuxdo' | 'xianbao';

export type Category =
  | 'free'
  | 'limited'
  | 'discount'
  | 'membership'
  | 'game'
  | 'other';

export type CategoryFilter = Category | 'all' | 'favorites';

export interface DealItem {
  id: number;
  title: string;
  link: string;
  description: string;
  source: SourceId;
  sourceName: string;
  category: Category;
  expiresAt: string | null;
  publishedAt: string | null;
  firstSeenAt: string;
  isNew: boolean;
  claimed: boolean;
  favorite: boolean;
  aiTitle: string | null;
  aiSummary: string | null;
  aiValue: string | null;
  aiAction: string | null;
}

export interface SourceStatus {
  id: SourceId;
  name: string;
  /** null 表示服务启动后尚未完成任何一轮抓取 */
  ok: boolean | null;
  count: number;
  error: string | null;
}

export interface DealsStats {
  activeCount: number;
  newCount: number;
}

export interface Announcement {
  enabled: boolean;
  text: string;
}

export interface SiteSettings {
  label: string;
  title: string;
  tagline: string;
}

export interface DealsMeta {
  fetchedAt: string | null;
  fetching: boolean;
  sources: SourceStatus[];
  stats: DealsStats;
  announcement: Announcement;
  site: SiteSettings;
  aiSearchEnabled: boolean;
  searchWindows: {
    ai: number;
    keyword: number;
  };
}

export interface DealsResponse extends DealsMeta {
  items: DealItem[];
}

export interface DealsListResponse extends DealsMeta {
  items: DealItem[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export interface AdminSource extends SourceStatus {
  order: number;
  hidden: boolean;
  url: string;
  kind: SourceKind;
  refreshMinutes: number | null;
  fetchedAt: string | null;
  activeCount: number;
  builtin: boolean;
}

export type RuntimeSettingType = 'text' | 'number' | 'password' | 'select';

export interface RuntimeSettingView {
  key: string;
  label: string;
  group: string;
  description: string;
  type: RuntimeSettingType;
  value: string;
  configured: boolean;
  secret?: boolean;
  options?: { value: string; label: string }[];
  restartRequired?: boolean;
  min?: number;
  max?: number;
}

export interface SearchIndexStatus {
  available: boolean;
  indexed: number;
  deals: number;
  version: string | null;
  builtAt: string | null;
  rebuilding: boolean;
  processed: number;
  total: number;
  lastError: string | null;
}

export interface AdminData {
  fetchedAt: string | null;
  announcement: Announcement;
  sources: AdminSource[];
  searchIndex: SearchIndexStatus;
  globalIntervalMinutes: number;
  runtimeSettings: RuntimeSettingView[];
}

export type AdminBaseData = Omit<
  AdminData,
  'globalIntervalMinutes' | 'runtimeSettings'
>;

