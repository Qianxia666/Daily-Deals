/** 来源标识由数据库动态维护，不再限制为固定枚举。 */
export type SourceId = string;

export type SourceKind =
  | 'rss'
  | 'epic'
  | 'linuxdo'
  | 'xianbao'
  | 'sina_weibo';

/** 来源三态：启用、停用（保留数据）、已移除（清空条目，可恢复）。 */
export type SourceState = 'active' | 'paused' | 'removed';

export interface DealItem {
  id: number;
  title: string;
  link: string;
  description: string;
  source: SourceId;
  sourceName: string;
  expiresAt: string | null;
  publishedAt: string | null;
  firstSeenAt: string;
  isNew: boolean;
  favorite: boolean;
  aiTitle: string | null;
  aiSummary: string | null;
  tags: string[];
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
  state: SourceState;
  url: string;
  kind: SourceKind;
  refreshMinutes: number | null;
  fetchedAt: string | null;
  activeCount: number;
  builtin: boolean;
}

export type RuntimeSettingType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'password'
  | 'select';

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
  /** 当前生效值的来源：后台保存 > .env > 代码默认值。 */
  source?: 'admin' | 'env' | 'default';
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

export interface TagStatus {
  enabled: boolean;
  total: number;
  tagged: number;
  pending: number;
  running: boolean;
  processed: number;
  batchTotal: number;
  taggedThisRun: number;
  failedThisRun: number;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  promoteThreshold: number;
}

export interface TagCandidate {
  tag: string;
  count: number;
  status: 'pending' | 'promoted' | 'blocked' | 'merged';
  mergedInto: string | null;
}

export interface TagSuggestion {
  tag: string;
  count: number;
}

export type ChannelKind = 'wecom' | 'feishu' | 'dingtalk' | 'bark';

export interface AccountUser {
  id: number;
  email: string;
  createdAt: string;
}

export interface AiQuota {
  limit: number;
  used: number;
  date: string;
}

export interface UserSubscription {
  id: number;
  keyword: string;
  enabled: boolean;
  createdAt: string;
}

/** 用户自己的推送机器人配置。secret/key 不会回传给前端。 */
export interface UserChannel {
  id: number;
  kind: ChannelKind;
  name: string;
  webhook: string;
  key: string;
  enabled: boolean;
  configured: boolean;
  createdAt: string;
}

export interface DeliveryRecord {
  id: number;
  dealId: number;
  title: string;
  link: string;
  keyword: string;
  channelName: string;
  channelKind: ChannelKind;
  status: 'pending' | 'sent' | 'failed' | 'digested' | 'skipped';
  error: string | null;
  createdAt: string;
  sentAt: string | null;
}

export interface AccountLimits {
  subscriptions: number;
  channelsPerKind: number;
  dailyPush: number;
}

export interface AccountData {
  user: AccountUser;
  aiQuota: AiQuota;
  limits: AccountLimits;
  subscriptions: UserSubscription[];
  channels: UserChannel[];
  deliveries: DeliveryRecord[];
}

export interface DigestItem {
  dealId: number;
  title: string;
  url: string;
}

export interface PublicDigestItem extends DigestItem {
  source: string;
  tags: string[];
  expired: boolean;
}

export interface PublicDigestTag {
  tag: string;
  count: number;
}

export interface PublicDigestGroup {
  tag: string;
  count: number;
  items: PublicDigestItem[];
}

export interface PublicDigest {
  date: string;
  title: string;
  stats: string[];
  tags: PublicDigestTag[];
  groups: PublicDigestGroup[];
}

export interface AdminUser {
  id: number;
  email: string;
  createdAt: string;
  lastLoginAt: string | null;
  disabled: boolean;
  inviteCode: string | null;
  aiQuotaUsed: number;
  subscriptionCount: number;
  channelCount: number;
}

export interface InviteCode {
  id: number;
  code: string;
  maxUses: number;
  usedCount: number;
  expiresAt: string | null;
  disabled: boolean;
  createdAt: string;
}

export interface AdminUserDetail {
  user: AdminUser;
  aiQuotaLimit: number;
  subscriptions: UserSubscription[];
  channels: UserChannel[];
  deliveries: DeliveryRecord[];
}

export interface AdminData {
  fetchedAt: string | null;
  announcement: Announcement;
  sources: AdminSource[];
  searchIndex: SearchIndexStatus;
  tags: TagStatus;
  tagCandidates: TagCandidate[];
  globalIntervalMinutes: number;
  runtimeSettings: RuntimeSettingView[];
  users: AdminUser[];
}

export type AdminBaseData = Omit<
  AdminData,
  'globalIntervalMinutes' | 'runtimeSettings'
>;

