import { SOURCE_NAMES } from './constants';
import type { SourceKind } from './types';

export interface SourceConfig {
  id: string;
  name: string;
  url: string;
  kind: SourceKind;
}

/** 允许通过环境变量覆盖内置来源的初始地址；后台保存后以数据库为准。 */
function envUrl(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value || fallback;
}

/**
 * 内置来源：仅在数据库首次初始化时写入 sources 表。
 * 之后管理员可以在后台上修改地址、刷新频率或隐藏来源。
 */
export const BUILTIN_SOURCES: SourceConfig[] = [
  {
    id: 'linuxdo',
    name: SOURCE_NAMES.linuxdo,
    // 默认走第三方 RSS 镜像：国内可直连，无需 Jina。
    // 抓取失败时会自动降级到 linux.do 直连与 Jina（详见 lib/fetchers/linuxdo.ts）。
    url: envUrl(
      'LINUXDO_FEED_URL',
      'https://linuxdorss.longpink.com/welfare.xml',
    ),
    kind: 'linuxdo',
  },
  {
    id: 'v2ex',
    name: SOURCE_NAMES.v2ex,
    url: envUrl('V2EX_FEED_URL', 'https://www.v2ex.com/feed/promotions.xml'),
    kind: 'rss',
  },
  {
    id: 'epic',
    name: SOURCE_NAMES.epic,
    url: envUrl(
      'EPIC_API_URL',
      'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=zh-CN&country=CN&allowCountries=CN',
    ),
    kind: 'epic',
  },
  {
    id: 'nodeseek',
    name: SOURCE_NAMES.nodeseek,
    url: envUrl('NODESEEK_FEED_URL', 'https://rss.nodeseek.com/'),
    kind: 'rss',
  },
  {
    id: 'appinn',
    name: SOURCE_NAMES.appinn,
    url: envUrl('APPINN_FEED_URL', 'https://www.appinn.com/feed/'),
    kind: 'rss',
  },
  {
    id: 'ghxi',
    name: SOURCE_NAMES.ghxi,
    url: envUrl('GHXI_FEED_URL', 'https://www.ghxi.com/feed'),
    kind: 'rss',
  },
  {
    id: 'iplaysoft',
    name: SOURCE_NAMES.iplaysoft,
    url: envUrl('IPLAYSOFT_FEED_URL', 'https://www.iplaysoft.com/feed'),
    kind: 'rss',
  },
  {
    id: 'lowendbox',
    name: SOURCE_NAMES.lowendbox,
    url: envUrl('LOWENDBOX_FEED_URL', 'https://lowendbox.com/feed/'),
    kind: 'rss',
  },
  {
    id: '52pojie',
    name: SOURCE_NAMES['52pojie'],
    // 福利经验区（fid=66）未开放 RSS，且站点 WAF 对该板块访问限制严格；
    // 默认使用 RSS 可用的精品软件区（fid=16），内容为免费软件资源。
    // 站点为 GBK 编码，抓取器会自动识别。
    url: envUrl(
      'POJIE_FEED_URL',
      'https://www.52pojie.cn/forum.php?mod=rss&fid=16',
    ),
    kind: 'rss',
  },
  {
    id: 'xianbao',
    name: SOURCE_NAMES.xianbao,
    url: envUrl('XIANBAO_FEED_URL', 'https://new.xianbao.fun/category-weibo/'),
    kind: 'xianbao',
  },
  {
    id: 'kuan',
    name: SOURCE_NAMES.kuan,
    url: envUrl('KUAN_FEED_URL', 'https://new.xianbao.fun/category-kuan/'),
    kind: 'xianbao',
  },
];

/** 单个来源的抓取超时，避免拖住整轮任务。 */
export const SOURCE_TIMEOUT_MS = 30_000;
