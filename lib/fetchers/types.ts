import type { Category, SourceId } from '../types';

export interface RawDeal {
  title: string;
  link: string;
  description: string;
  publishedAt: string | null;
  expiresAt: string | null;
  category: Category;
  source: SourceId;
}
