import type { SourceId } from '../types';

export interface RawDeal {
  title: string;
  link: string;
  description: string;
  publishedAt: string | null;
  expiresAt: string | null;
  source: SourceId;
  /** 正文是否已经完整抓取；列表页摘要入库时为 false。 */
  bodyComplete?: boolean;
}
