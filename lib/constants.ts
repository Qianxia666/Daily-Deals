import type { Category, CategoryFilter } from './types';

/** 内置来源的默认名称；后台新增来源的名称保存在数据库中。 */
export const SOURCE_NAMES: Record<string, string> = {
  linuxdo: 'linux.do',
  v2ex: 'V2EX 推广',
  epic: 'Epic 免费游戏',
  nodeseek: 'NodeSeek',
  appinn: '小众软件',
  ghxi: '果核剥壳',
  iplaysoft: '异次元软件世界',
  lowendbox: 'LowEndBox',
  '52pojie': '吾爱破解',
  xianbao: '线报酷',
  kuan: '酷安',
};

export const CATEGORY_ORDER: Category[] = [
  'free',
  'limited',
  'discount',
  'membership',
  'game',
  'other',
];

export const CATEGORY_LABELS: Record<Category, string> = {
  free: '免费白嫖',
  limited: '限免',
  discount: '低价优惠',
  membership: '会员订阅',
  game: '游戏',
  other: '其他',
};

export const CATEGORY_FILTERS: { value: CategoryFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  ...CATEGORY_ORDER.map((value) => ({
    value: value as CategoryFilter,
    label: CATEGORY_LABELS[value],
  })),
  { value: 'favorites', label: '我的收藏' },
];
