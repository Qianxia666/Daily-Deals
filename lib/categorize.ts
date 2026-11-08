import type { Category } from './types';

const RULES: Array<{ pattern: RegExp; category: Category }> = [
  {
    pattern: /epic|游戏|喜加一|steam|\bgame\b|free game/i,
    category: 'game',
  },
  {
    pattern: /会员|订阅|\bpro\b|membership|subscription/i,
    category: 'membership',
  },
  {
    pattern: /限免|免费领取|限时免费|free for a limited time|100%\s*off/i,
    category: 'limited',
  },
  {
    pattern: /白嫖|免费|free|giveaway|gratis/i,
    category: 'free',
  },
  {
    pattern:
      /折扣|优惠码|优惠|大促|降价|立减|满减|券|deal|offer|discount|sale|coupon|promo|voucher|\d+(?:\.\d+)?\s*元/i,
    category: 'discount',
  },
];

/** 按标题关键词归类，命中即停止；未命中归入「其他」。 */
export function categorizeTitle(title: string): Category {
  for (const rule of RULES) {
    if (rule.pattern.test(title)) return rule.category;
  }
  return 'other';
}
