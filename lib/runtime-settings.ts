import {
  getAdminData,
  getPromotedTags,
  getRuntimeEnvRaw,
  getSetting,
  setSetting,
} from './db';
import type {
  AdminData,
  RuntimeSettingType,
  RuntimeSettingView,
  SiteSettings,
} from './types';

export { getRuntimeEnvRaw };

interface RuntimeFieldDef {
  key: string;
  label: string;
  group: string;
  description: string;
  type: RuntimeSettingType;
  secret?: boolean;
  hidden?: boolean;
  defaultValue?: string;
  options?: { value: string; label: string }[];
  restartRequired?: boolean;
  min?: number;
  max?: number;
}

/** 默认品类标签词表；模型只会从这里选标签。 */
export const DEFAULT_TAG_VOCABULARY = [
  '奶茶',
  '咖啡',
  '快餐',
  '外卖',
  '零食',
  '生鲜',
  '酒水',
  '视频会员',
  '音乐会员',
  '网盘会员',
  '电商会员',
  '红包',
  '返利',
  '支付优惠',
  '话费',
  '流量卡',
  '宽带',
  '云服务器',
  '域名',
  '虚拟主机',
  'CDN',
  'SSL证书',
  '游戏',
  'Steam',
  'Epic',
  '手游',
  '主机游戏',
  '手机',
  '笔记本',
  '平板',
  '键盘',
  '鼠标',
  '耳机',
  '显示器',
  '充电宝',
  '存储',
  '相机',
  '数码配件',
  'AI工具',
  '办公软件',
  '设计工具',
  '开发工具',
  '系统工具',
  '安全软件',
  '打车',
  '机票',
  '酒店',
  '火车票',
  '加油',
  '电影票',
  '快递',
  '健身',
  '运动户外',
  '汽车服务',
  '生活服务',
  '课程',
  '电子书',
  '图书',
  '办公用品',
  '服饰',
  '鞋包',
  '美妆',
  '母婴',
  '宠物',
  '家电',
  '日用',
  '虚拟权益',
  '其他',
];

/**
 * 后台可修改的运行时配置。除容器级参数外，保存后会在下一次读取时立即生效，
 * 无需重启服务。
 */
const FIELDS: RuntimeFieldDef[] = [
  {
    key: 'LLM_ENABLED',
    label: '启用 AI 摘要',
    group: 'AI 改写与搜索',
    description:
      '关闭后不再生成 AI 标题与摘要；不影响 AI 搜索，两个开关互相独立。',
    type: 'select',
    defaultValue: 'true',
    options: [
      { value: 'true', label: '开启' },
      { value: 'false', label: '关闭' },
    ],
  },
  {
    key: 'AI_SEARCH_ENABLED',
    label: '启用 AI 搜索',
    group: 'AI 改写与搜索',
    description:
      '关闭后前台只提供普通搜索，AI 搜索入口会被禁用；不影响 AI 标题与摘要。',
    type: 'select',
    defaultValue: 'true',
    options: [
      { value: 'true', label: '开启' },
      { value: 'false', label: '关闭' },
    ],
  },
  {
    key: 'AI_SEARCH_SCOPE',
    label: 'AI 搜索范围',
    group: 'AI 改写与搜索',
    description:
      '所有在架：只要未过期就能搜到；按天数：只查最近 N 天。',
    type: 'select',
    defaultValue: 'active',
    options: [
      { value: 'active', label: '所有在架优惠' },
      { value: 'days', label: '按天数' },
    ],
  },
  {
    key: 'AI_SEARCH_DAYS',
    label: 'AI 搜索时间范围（天）',
    group: 'AI 改写与搜索',
    description:
      '仅当「AI 搜索范围」选择按天数时生效；实际范围不会超过数据保留天数。',
    type: 'number',
    defaultValue: '3',
    min: 1,
    max: 365,
  },
  {
    key: 'AI_SEARCH_RECALL_LIMIT',
    label: '全文召回候选条数',
    group: 'AI 改写与搜索',
    description:
      '先由全文索引筛出多少条候选，再交给 AI 精排；默认 60，数据量大时可调到 80–100。',
    type: 'number',
    defaultValue: '60',
    min: 20,
    max: 200,
  },
  {
    key: 'AI_SEARCH_RERANK_LIMIT',
    label: 'AI 精排返回条数',
    group: 'AI 改写与搜索',
    description: 'AI 从候选中最多选出多少条结果，默认 20。',
    type: 'number',
    defaultValue: '20',
    min: 5,
    max: 30,
  },
  {
    key: 'AI_SEARCH_RERANK_ENABLED',
    label: '启用 AI 精排',
    group: 'AI 改写与搜索',
    description:
      '关闭后直接返回全文索引排序结果，不调用 AI，速度更快但语义理解较弱。',
    type: 'select',
    defaultValue: 'true',
    options: [
      { value: 'true', label: '开启' },
      { value: 'false', label: '关闭' },
    ],
  },
  {
    key: 'AI_TAGS_ENABLED',
    label: '启用品类标签',
    group: 'AI 改写与搜索',
    description:
      '生成 AI 摘要时顺带为每条优惠打 1–3 个品类标签。开启后搜「奶茶」可以命中蜜雪冰城、茶百道等品牌条目。',
    type: 'select',
    defaultValue: 'true',
    options: [
      { value: 'true', label: '开启' },
      { value: 'false', label: '关闭' },
    ],
  },
  {
    key: 'AI_TAG_VOCABULARY',
    label: '品类标签词表',
    group: 'AI 改写与搜索',
    description:
      '每行或用逗号分隔。模型只会从词表里选标签；新增品类后保存即可，存量数据可在「品类标签」区域一键补全。',
    type: 'textarea',
    defaultValue: DEFAULT_TAG_VOCABULARY.join('\n'),
  },
  {
    key: 'AI_TAGS_PROPOSE_ENABLED',
    label: '允许 AI 提议新标签',
    group: 'AI 改写与搜索',
    description:
      '词表都不合适时，允许模型提出 0–3 个新品类词并进入候选池；候选不会直接影响前台标签建议。',
    type: 'select',
    defaultValue: 'true',
    options: [
      { value: 'true', label: '开启' },
      { value: 'false', label: '关闭' },
    ],
  },
  {
    key: 'AI_TAGS_PROPOSE_MAX',
    label: '每条最多提议标签数',
    group: 'AI 改写与搜索',
    description: '默认 2，设为 0 表示不提议新标签；提议词不会进入正式词表。',
    type: 'number',
    defaultValue: '2',
    min: 0,
    max: 3,
  },
  {
    key: 'AI_TAGS_PROMOTE_THRESHOLD',
    label: '候选自动转正阈值',
    group: 'AI 改写与搜索',
    description:
      '同一提议标签被多少条优惠使用后进入可转正状态，默认 3；达到阈值的提议标签也会进入零结果标签建议。',
    type: 'number',
    defaultValue: '3',
    min: 2,
    max: 20,
  },
  {
    key: 'AI_TAGS_CANDIDATE_LIMIT',
    label: '标签候选池上限',
    group: 'AI 改写与搜索',
    description:
      '候选池最多保留多少个待审核标签，默认 500；超出后先淘汰只出现过一次的。',
    type: 'number',
    defaultValue: '500',
    min: 50,
    max: 5000,
  },
  {
    key: 'AI_TAGS_BRAND_EXTRACT_ENABLED',
    label: '抽取品牌与产品实体',
    group: 'AI 改写与搜索',
    description:
      '从标题与描述中抽取 brands、products 写入独立索引；抽取结果必须能在原文找到，权重低于标题。',
    type: 'select',
    defaultValue: 'true',
    options: [
      { value: 'true', label: '开启' },
      { value: 'false', label: '关闭' },
    ],
  },
  {
    key: 'SEARCH_SUGGEST_TAGS',
    label: '零结果推荐标签数',
    group: 'AI 改写与搜索',
    description:
      '搜索无结果时最多推荐多少个可点击的标签，默认 6；设为 0 表示不推荐。',
    type: 'number',
    defaultValue: '6',
    min: 0,
    max: 12,
  },
  {
    key: 'SEARCH_REWRITE_ON_EMPTY_RERANK',
    label: '精排为空时再次改写',
    group: 'AI 改写与搜索',
    description:
      '召回有候选但 AI 精排全部过滤时，再改写一次搜索词重新精排；默认开启。',
    type: 'select',
    defaultValue: 'true',
    options: [
      { value: 'true', label: '开启' },
      { value: 'false', label: '关闭' },
    ],
  },
  {
    key: 'AI_SEARCH_USE_SUMMARY',
    label: 'AI 精排参考摘要',
    group: 'AI 改写与搜索',
    description:
      '开启后把 AI 摘要一起交给模型，比只看标题更准；关闭则只发标题。',
    type: 'select',
    defaultValue: 'true',
    options: [
      { value: 'true', label: '开启' },
      { value: 'false', label: '关闭' },
    ],
  },
  {
    key: 'AI_SEARCH_FTS_ENABLED',
    label: '启用全文索引',
    group: 'AI 改写与搜索',
    description:
      '关闭后回退到旧的关键词粗筛逻辑；仅在索引异常时临时关闭。',
    type: 'select',
    defaultValue: 'true',
    options: [
      { value: 'true', label: '开启' },
      { value: 'false', label: '关闭' },
    ],
  },
  {
    key: 'AI_SEARCH_SYNONYM_ENABLED',
    label: '启用同义词扩展',
    group: 'AI 改写与搜索',
    description:
      '例如白嫖→免费、云服务器→VPS/主机，提升口语化搜索的命中率。',
    type: 'select',
    defaultValue: 'true',
    options: [
      { value: 'true', label: '开启' },
      { value: 'false', label: '关闭' },
    ],
  },
  {
    key: 'AI_SEARCH_REWRITE_ENABLED',
    label: '零结果时改写搜索词',
    group: 'AI 改写与搜索',
    description:
      'AI 搜索没有召回任何候选时，让模型把口语改写成品类词再搜一次；只影响未命中的请求。',
    type: 'select',
    defaultValue: 'true',
    options: [
      { value: 'true', label: '开启' },
      { value: 'false', label: '关闭' },
    ],
  },
  {
    key: 'AI_SEARCH_REWRITE_TIMEOUT_MS',
    label: '改写超时（毫秒）',
    group: 'AI 改写与搜索',
    description:
      '改写请求的等待上限，超时直接返回空结果，避免拖慢搜索；默认 8000。',
    type: 'number',
    defaultValue: '8000',
    min: 2000,
    max: 30000,
  },
  {
    key: 'AI_SEARCH_REWRITE_PER_MINUTE',
    label: '改写每分钟上限',
    group: 'AI 改写与搜索',
    description:
      '全站每分钟最多触发多少次改写，控制额外模型成本；默认 20。',
    type: 'number',
    defaultValue: '20',
    min: 1,
    max: 200,
  },
  {
    key: 'AI_SEARCH_INDEX_MAX_CHARS',
    label: '索引文本最大长度',
    group: 'AI 改写与搜索',
    description:
      '每条优惠进入全文索引时最多截取多少字符，默认 400；修改后需在后台重建索引。',
    type: 'number',
    defaultValue: '400',
    min: 200,
    max: 1000,
  },
  {
    key: 'AI_SEARCH_MAX_PER_SOURCE',
    label: '单来源候选上限',
    group: 'AI 改写与搜索',
    description:
      '每个来源最多进入多少条候选，0 表示不限制；用于避免大来源占满结果。',
    type: 'number',
    defaultValue: '0',
    min: 0,
    max: 50,
  },
  {
    key: 'AI_SEARCH_MODEL',
    label: 'AI 搜索专用模型',
    group: 'AI 改写与搜索',
    description:
      '留空则沿用上方 AI 模型；可单独为搜索精排配置更强的模型。',
    type: 'text',
    defaultValue: '',
  },
  {
    key: 'KEYWORD_SEARCH_MAX_RESULTS',
    label: '普通搜索最多返回条数',
    group: 'AI 改写与搜索',
    description: '普通搜索最多返回多少条匹配结果，默认 100。',
    type: 'number',
    defaultValue: '100',
    min: 20,
    max: 500,
  },
  {
    key: 'AI_SEARCH_MAX_ITEMS',
    label: '旧版粗筛提交上限',
    group: 'AI 改写与搜索',
    description:
      '仅在「启用全文索引」关闭时生效；新版全文索引使用上面的召回条数。',
    type: 'number',
    defaultValue: '500',
    min: 50,
    max: 5000,
  },
  {
    key: 'AI_SEARCH_COARSE_STRATEGY',
    label: '旧版粗筛策略',
    group: 'AI 改写与搜索',
    description:
      '仅在「启用全文索引」关闭时生效：均衡按来源轮流取样，或只保留最新条目。',
    type: 'select',
    defaultValue: 'balanced',
    options: [
      { value: 'balanced', label: '按来源均衡取样' },
      { value: 'recent', label: '只取最新条目' },
    ],
  },
  {
    key: 'AI_SEARCH_CACHE_ENABLED',
    label: '启用搜索结果缓存',
    group: 'AI 改写与搜索',
    description: '相同搜索词在缓存时间内直接复用结果，减少重复 AI 请求。',
    type: 'select',
    defaultValue: 'true',
    options: [
      { value: 'true', label: '开启' },
      { value: 'false', label: '关闭' },
    ],
  },
  {
    key: 'AI_SEARCH_CACHE_MINUTES',
    label: '搜索缓存时间（分钟）',
    group: 'AI 改写与搜索',
    description: '搜索结果缓存多久，默认 5 分钟。',
    type: 'number',
    defaultValue: '5',
    min: 1,
    max: 120,
  },
  {
    key: 'KEYWORD_SEARCH_DAYS',
    label: '普通搜索时间范围（天）',
    group: 'AI 改写与搜索',
    description:
      '普通搜索匹配最近多少天的优惠，默认 30 天；实际范围不会超过数据保留天数。',
    type: 'number',
    defaultValue: '30',
    min: 1,
    max: 365,
  },
  {
    key: 'LLM_BASE_URL',
    label: 'AI 接口地址',
    group: 'AI 改写与搜索',
    description: 'OpenAI 兼容地址，需包含 /v1；留空则关闭 AI 改写。',
    type: 'text',
    defaultValue: '',
  },
  {
    key: 'LLM_API_KEY',
    label: 'AI API Key',
    group: 'AI 改写与搜索',
    description: '留空表示保持当前值不变。',
    type: 'password',
    secret: true,
  },
  {
    key: 'LLM_MODEL',
    label: 'AI 模型',
    group: 'AI 改写与搜索',
    description: '例如 Qwen/Qwen3-30B-A3B-Instruct-2507；留空则关闭 AI 改写。',
    type: 'text',
    defaultValue: '',
  },
  {
    key: 'LLM_MAX_ITEMS_PER_RUN',
    label: '每轮最多改写条数',
    group: 'AI 改写与搜索',
    description: '控制单轮 AI 改写耗时与成本。',
    type: 'number',
    defaultValue: '80',
    min: 1,
    max: 200,
  },
  {
    key: 'AI_SUMMARY_BATCH_SIZE',
    label: '每批摘要条数',
    group: 'AI 改写与搜索',
    description:
      '每次请求合并多少条一起生成，默认 20；建议 20–30，过大可能输出截断。',
    type: 'number',
    defaultValue: '20',
    min: 5,
    max: 30,
  },
  {
    key: 'AI_SUMMARY_RETRY_SIZE',
    label: '补漏批次条数',
    group: 'AI 改写与搜索',
    description:
      '一批里若有缺失条目，同一轮只再请求一次，最多补这么多条，默认 10。',
    type: 'number',
    defaultValue: '10',
    min: 1,
    max: 30,
  },
  {
    key: 'AI_SUMMARY_MAX_ATTEMPTS',
    label: '摘要最大尝试次数',
    group: 'AI 改写与搜索',
    description:
      '同一条失败达到该次数后不再重试，保留原标题，默认 3 次。',
    type: 'number',
    defaultValue: '3',
    min: 1,
    max: 10,
  },
  {
    key: 'LLM_CONCURRENCY',
    label: 'AI 并发数',
    group: 'AI 改写与搜索',
    description: '建议 2–3，过高可能被接口限流。',
    type: 'number',
    defaultValue: '3',
    min: 1,
    max: 6,
  },
  {
    key: 'LLM_TIMEOUT_MS',
    label: 'AI 单次请求超时（毫秒）',
    group: 'AI 改写与搜索',
    description: '单次批量请求的超时时间，默认 120000（2 分钟）。',
    type: 'number',
    defaultValue: '120000',
    min: 10000,
    max: 300000,
  },
  {
    key: 'SITE_LABEL',
    label: '顶部英文标识',
    group: '站点显示',
    description: '首页顶部的小号英文标识，默认 Daily Deals。',
    type: 'text',
    defaultValue: 'Daily Deals',
  },
  {
    key: 'SITE_TITLE',
    label: '站点主标题',
    group: '站点显示',
    description: '首页顶部的大标题，默认「每日优惠情报」。',
    type: 'text',
    defaultValue: '每日优惠情报',
  },
  {
    key: 'SITE_TAGLINE',
    label: '站点副标题',
    group: '站点显示',
    description:
      '主标题下方的一行说明，默认「AI 精简 · 定时自动聚合 · 只收录真实来源」。',
    type: 'text',
    defaultValue: 'AI 精简 · 定时自动聚合 · 只收录真实来源',
  },
  {
    key: 'SITE_URL',
    label: '站点公开地址',
    group: '站点显示',
    description:
      '用于生成推送里的详情页链接，例如 https://your.site；留空则回退到优惠原始链接。',
    type: 'text',
    defaultValue: '',
  },
  {
    key: 'DATA_RETENTION_DAYS',
    label: '数据保留天数',
    group: '抓取',
    description:
      '超过该天数的条目会在下一轮抓取时清理，默认 30 天。搜索时间范围不会超过该值。',
    type: 'number',
    defaultValue: '30',
    min: 1,
    max: 365,
  },
  {
    key: 'FETCH_INTERVAL_MINUTES',
    label: '全局刷新间隔（分钟）',
    group: '抓取',
    description:
      '未单独设置刷新间隔的来源使用该值，允许 5–1440 分钟。修改后下一轮调度立即按新间隔判断。',
    type: 'number',
    defaultValue: '120',
    min: 5,
    max: 1440,
  },
  {
    key: 'OUTBOUND_PROXY',
    label: '出站代理',
    group: '网络',
    description:
      '例如 http://127.0.0.1:7890。直连失败时可在此配置代理，保存后下一次抓取生效。',
    type: 'text',
  },
  {
    key: 'JINA_API_KEY',
    label: 'Jina Reader Key',
    group: '网络',
    description:
      'linux.do 镜像与直连都失败时用于兜底抓取。留空表示保持当前值不变。',
    type: 'password',
    secret: true,
  },
  {
    key: 'RATE_LIMIT_ENABLED',
    label: '启用访问限流',
    group: '限流',
    description:
      '按客户端 IP 限制搜索与后台登录频率；未取到 IP 时按全局计数。',
    type: 'select',
    defaultValue: 'true',
    options: [
      { value: 'true', label: '开启' },
      { value: 'false', label: '关闭' },
    ],
  },
  {
    key: 'SEARCH_RATE_LIMIT_PER_MINUTE',
    label: '搜索每分钟上限',
    group: '限流',
    description: '同一来源每分钟最多发起多少次搜索，默认 60 次。',
    type: 'number',
    defaultValue: '60',
    min: 1,
    max: 300,
  },
  {
    key: 'ADMIN_LOGIN_RATE_LIMIT_PER_MINUTE',
    label: '后台登录每分钟上限',
    group: '限流',
    description: '同一来源每分钟最多尝试登录后台多少次，默认 5 次。',
    type: 'number',
    defaultValue: '5',
    min: 1,
    max: 60,
  },
  {
    key: 'ALERTS_ENABLED',
    label: '启用来源失败告警',
    group: '通知渠道',
    description: '来源连续抓取失败时，向下方已启用的通知渠道推送提醒。',
    type: 'select',
    defaultValue: 'true',
    options: [
      { value: 'true', label: '开启' },
      { value: 'false', label: '关闭' },
    ],
  },
  {
    key: 'FEISHU_WEBHOOK_URL',
    label: '飞书机器人 Webhook（旧版）',
    group: '通知渠道',
    description: '旧版告警配置，后台已隐藏；仍会作为飞书渠道的兜底配置。',
    type: 'text',
    hidden: true,
  },
  {
    key: 'FEISHU_WEBHOOK_SECRET',
    label: '飞书机器人签名密钥（旧版）',
    group: '通知渠道',
    description: '旧版告警配置，后台已隐藏；仍会作为飞书渠道的兜底配置。',
    type: 'password',
    secret: true,
    hidden: true,
  },
  {
    key: 'ALERT_FAILURE_THRESHOLD',
    label: '连续失败告警阈值',
    group: '通知渠道',
    description: '同一来源连续失败多少轮后推送告警，默认 3 轮。',
    type: 'number',
    defaultValue: '3',
    min: 1,
    max: 10,
  },
  {
    key: 'ALERT_COOLDOWN_MINUTES',
    label: '告警冷却时间（分钟）',
    group: '通知渠道',
    description: '同一来源两次告警之间的最小间隔，默认 60 分钟。',
    type: 'number',
    defaultValue: '60',
    min: 5,
    max: 1440,
  },
  {
    key: 'REGISTRATION_OPEN',
    label: '开放用户注册',
    group: '用户与订阅',
    description:
      '关闭后前台只能登录已有账号，注册接口会直接拒绝；后台账号不受影响。',
    type: 'select',
    defaultValue: 'true',
    options: [
      { value: 'true', label: '开放注册' },
      { value: 'false', label: '仅管理员可建号' },
    ],
  },
  {
    key: 'REGISTRATION_INVITE_REQUIRED',
    label: '注册必须使用邀请码',
    group: '用户与订阅',
    description:
      '开启后注册必须填写下方「邀请码管理」中生成的有效邀请码；关闭则无需邀请码。',
    type: 'select',
    defaultValue: 'false',
    options: [
      { value: 'true', label: '需要邀请码' },
      { value: 'false', label: '不需要' },
    ],
  },
  {
    key: 'REGISTRATION_INVITE_CODE',
    label: '旧版注册邀请码（兼容）',
    group: '用户与订阅',
    description:
      '仅用于兼容旧配置：填写后，该固定码仍可无限次注册。新邀请码请在下方「邀请码管理」生成。',
    type: 'text',
    defaultValue: '',
  },
  {
    key: 'AI_SEARCH_DAILY_LIMIT',
    label: 'AI 搜索每日次数',
    group: '用户与订阅',
    description:
      '每个登录用户每天可用的 AI 搜索次数，默认 50；填 0 表示不限制。',
    type: 'number',
    defaultValue: '50',
    min: 0,
    max: 1000,
  },
  {
    key: 'ACCOUNT_MAX_SUBSCRIPTIONS',
    label: '每人订阅关键词上限',
    group: '用户与订阅',
    description: '每个用户最多可创建多少个关键词订阅，默认 20。',
    type: 'number',
    defaultValue: '20',
    min: 1,
    max: 200,
  },
  {
    key: 'ACCOUNT_MAX_CHANNELS_PER_KIND',
    label: '每种渠道数量上限',
    group: '用户与订阅',
    description: '每个用户每种推送渠道最多绑定几个机器人，默认 2。',
    type: 'number',
    defaultValue: '2',
    min: 1,
    max: 10,
  },
  {
    key: 'ACCOUNT_DAILY_PUSH_LIMIT',
    label: '每人每日推送上限',
    group: '用户与订阅',
    description:
      '每个用户每天最多收到多少条订阅推送，默认 20；超出后不再逐条推送，改为 20:30 的合并摘要，不会顺延到次日。',
    type: 'number',
    defaultValue: '20',
    min: 1,
    max: 500,
  },
  {
    key: 'DIGEST_OVERFLOW_ENABLED',
    label: '启用超限合并推送',
    group: '用户与订阅',
    description:
      '达到每日推送上限后，把当天剩余条目合并成一条摘要推送；关闭后剩余条目不推送。',
    type: 'select',
    defaultValue: 'true',
    options: [
      { value: 'true', label: '开启' },
      { value: 'false', label: '关闭' },
    ],
  },
  {
    key: 'DIGEST_OVERFLOW_TIME',
    label: '超限合并推送时间',
    group: '用户与订阅',
    description:
      '每天什么时候发送超限合并摘要，默认 20:30，格式 HH:mm，按北京时间执行。',
    type: 'text',
    defaultValue: '20:30',
  },
  {
    key: 'DIGEST_SITE_ENABLED',
    label: '启用每日全站汇总',
    group: '用户与订阅',
    description:
      '每天向所有有启用订阅和渠道的用户发送一次全站优惠汇总，不占用个人每日推送额度。',
    type: 'select',
    defaultValue: 'true',
    options: [
      { value: 'true', label: '开启' },
      { value: 'false', label: '关闭' },
    ],
  },
  {
    key: 'DIGEST_SITE_TIME',
    label: '全站汇总推送时间',
    group: '用户与订阅',
    description:
      '每天什么时候发送全站优惠汇总，默认 21:00，格式 HH:mm，按北京时间执行。',
    type: 'text',
    defaultValue: '21:00',
  },
  {
    key: 'DIGEST_SITE_MAX_ITEMS',
    label: '全站汇总精选条数',
    group: '用户与订阅',
    description: '每日全站汇总最多列出多少条优惠，默认 8；其余通过详情页查看。',
    type: 'number',
    defaultValue: '8',
    min: 1,
    max: 8,
  },
  {
    key: 'NOTIFY_WECOM_ENABLED',
    label: '启用企业微信渠道',
    group: '通知渠道',
    description: '后台告警与用户订阅推送都可以使用企业微信群机器人。',
    type: 'select',
    defaultValue: 'true',
    options: [
      { value: 'true', label: '开启' },
      { value: 'false', label: '关闭' },
    ],
  },
  {
    key: 'NOTIFY_WECOM_WEBHOOK',
    label: '企业微信机器人 Webhook',
    group: '通知渠道',
    description:
      '形如 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx；后台告警使用。',
    type: 'text',
    defaultValue: '',
  },
  {
    key: 'NOTIFY_FEISHU_ENABLED',
    label: '启用飞书渠道',
    group: '通知渠道',
    description: '未单独填写时，后台飞书告警沿用上方「飞书机器人 Webhook」。',
    type: 'select',
    defaultValue: 'true',
    options: [
      { value: 'true', label: '开启' },
      { value: 'false', label: '关闭' },
    ],
  },
  {
    key: 'NOTIFY_FEISHU_WEBHOOK',
    label: '飞书机器人 Webhook（通知推送）',
    group: '通知渠道',
    description:
      '留空则沿用「告警」分组里的 Feishu Webhook；填写后优先使用这里。',
    type: 'text',
    defaultValue: '',
  },
  {
    key: 'NOTIFY_FEISHU_SECRET',
    label: '飞书签名密钥（通知推送）',
    group: '通知渠道',
    description:
      '机器人开启签名校验时填写；留空则沿用告警分组的签名密钥。',
    type: 'password',
    secret: true,
  },
  {
    key: 'NOTIFY_DINGTALK_ENABLED',
    label: '启用钉钉渠道',
    group: '通知渠道',
    description: '钉钉群自定义机器人，支持加签。',
    type: 'select',
    defaultValue: 'true',
    options: [
      { value: 'true', label: '开启' },
      { value: 'false', label: '关闭' },
    ],
  },
  {
    key: 'NOTIFY_DINGTALK_WEBHOOK',
    label: '钉钉机器人 Webhook',
    group: '通知渠道',
    description:
      '形如 https://oapi.dingtalk.com/robot/send?access_token=xxx；后台告警使用。',
    type: 'text',
    defaultValue: '',
  },
  {
    key: 'NOTIFY_DINGTALK_SECRET',
    label: '钉钉加签密钥',
    group: '通知渠道',
    description: '机器人安全设置选择「加签」时填写，否则留空。',
    type: 'password',
    secret: true,
  },
  {
    key: 'NOTIFY_BARK_ENABLED',
    label: '启用 Bark 渠道',
    group: '通知渠道',
    description: 'Bark iOS 推送服务，填设备 Key 或完整 https 地址。',
    type: 'select',
    defaultValue: 'true',
    options: [
      { value: 'true', label: '开启' },
      { value: 'false', label: '关闭' },
    ],
  },
  {
    key: 'NOTIFY_BARK_KEY',
    label: 'Bark 设备 Key',
    group: '通知渠道',
    description:
      '例如 abcdefg123；也可填写 https://api.day.app/abcdefg123。后台告警使用。',
    type: 'password',
    secret: true,
  },
  {
    key: 'BACKUP_ENABLED',
    label: '启用数据库自动备份',
    group: '备份',
    description: '按间隔把 SQLite 数据库快照到备份目录。',
    type: 'select',
    defaultValue: 'true',
    options: [
      { value: 'true', label: '开启' },
      { value: 'false', label: '关闭' },
    ],
  },
  {
    key: 'BACKUP_INTERVAL_HOURS',
    label: '备份间隔（小时）',
    group: '备份',
    description: '两次自动备份之间的间隔，默认 24 小时。',
    type: 'number',
    defaultValue: '24',
    min: 1,
    max: 168,
  },
  {
    key: 'BACKUP_KEEP',
    label: '备份保留份数',
    group: '备份',
    description: '最多保留多少份备份，超出后删除最旧的，默认 7 份。',
    type: 'number',
    defaultValue: '7',
    min: 1,
    max: 30,
  },
  {
    key: 'BACKUP_DIR',
    label: '备份目录',
    group: '备份',
    description:
      '容器内备份目录，默认 ./data/backups（会随 ./data 一起挂载到宿主机）。',
    type: 'text',
    defaultValue: './data/backups',
  },
  {
    key: 'API_ETAG_ENABLED',
    label: '启用接口 ETag',
    group: '接口与缓存',
    description:
      '首页数据未变化时返回 304，减少轮询流量；关闭后每次都返回完整数据。',
    type: 'select',
    defaultValue: 'true',
    options: [
      { value: 'true', label: '开启' },
      { value: 'false', label: '关闭' },
    ],
  },
  {
    key: 'ADMIN_PASSWORD',
    label: '管理后台密码',
    group: '管理员',
    description: '至少 4 位；留空表示保持当前密码不变。',
    type: 'password',
    secret: true,
  },
  {
    key: 'ADMIN_SESSION_SECRET',
    label: '会话签名密钥',
    group: '管理员',
    description:
      '修改后所有已登录会话会失效；留空表示保持当前值不变。',
    type: 'password',
    secret: true,
  },
  {
    key: 'TZ',
    label: '容器时区',
    group: '容器',
    description:
      '容器级参数，请在服务器 .env 中修改并重建容器；后台保存仅作记录。',
    type: 'text',
    defaultValue: 'Asia/Shanghai',
    restartRequired: true,
  },
  {
    key: 'PORT',
    label: '宿主机端口',
    group: '容器',
    description:
      '容器级参数，请在服务器 .env 中修改并重建容器；后台保存仅作记录。',
    type: 'number',
    defaultValue: '3000',
    restartRequired: true,
  },
  {
    key: 'DATABASE_PATH',
    label: '数据库路径',
    group: '容器',
    description:
      '容器级参数，请在服务器 .env 中修改并重建容器；后台保存仅作记录。',
    type: 'text',
    defaultValue: './data/app.db',
    restartRequired: true,
  },
  {
    key: 'LOG_MAX_SIZE',
    label: 'Docker 日志单文件上限',
    group: '容器',
    description:
      '容器级参数，例如 10m；请在服务器 .env 中修改并重建容器。',
    type: 'text',
    defaultValue: '10m',
    restartRequired: true,
  },
  {
    key: 'LOG_MAX_FILE',
    label: 'Docker 日志保留文件数',
    group: '容器',
    description:
      '容器级参数，默认 3；请在服务器 .env 中修改并重建容器。',
    type: 'number',
    defaultValue: '3',
    min: 1,
    max: 20,
    restartRequired: true,
  },
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function effectiveValue(def: RuntimeFieldDef): string {
  const raw = getRuntimeEnvRaw(def.key);

  if (def.type === 'select') {
    if (raw === null || raw.trim() === '') return def.defaultValue ?? '';
    return (def.options ?? []).some((option) => option.value === raw.trim())
      ? raw.trim()
      : (def.defaultValue ?? '');
  }

  if (raw === null) return def.defaultValue ?? '';
  return raw;
}

/** 读取运行时字符串配置：后台保存的值优先，其次 .env 中的非空值。 */
export function getRuntimeEnv(key: string, fallback = ''): string {
  const raw = getRuntimeEnvRaw(key);
  return raw === null ? fallback : raw;
}

/** 读取布尔型开关，只有显式填写 false 才视为关闭。 */
export function getRuntimeBool(key: string, fallback = true): boolean {
  const raw = getRuntimeEnvRaw(key);
  if (raw === null || raw.trim() === '') return fallback;
  return raw.trim() !== 'false';
}

export function getRuntimeEnvNumber(
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = getRuntimeEnvRaw(key);
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return clamp(Math.round(value), min, max);
}

/** 全局刷新间隔（分钟）。 */
export function getGlobalIntervalMinutes(): number {
  return getRuntimeEnvNumber('FETCH_INTERVAL_MINUTES', 120, 5, 1440);
}

/** AI 搜索默认时间范围（天）。 */
export function getAiSearchDays(): number {
  return getRuntimeEnvNumber('AI_SEARCH_DAYS', 3, 1, 365);
}

/** 普通搜索默认时间范围（天）。 */
export function getKeywordSearchDays(): number {
  return getRuntimeEnvNumber('KEYWORD_SEARCH_DAYS', 30, 1, 365);
}

/** AI 搜索最多提交给模型的标题数。 */
export function getAiSearchMaxItems(): number {
  return getRuntimeEnvNumber('AI_SEARCH_MAX_ITEMS', 500, 50, 5000);
}

/** 超出提交上限时的粗筛策略。 */
export function getAiSearchCoarseStrategy(): 'balanced' | 'recent' {
  const raw = getRuntimeEnv('AI_SEARCH_COARSE_STRATEGY', 'balanced').trim();
  return raw === 'recent' ? 'recent' : 'balanced';
}

/** AI 搜索范围：所有在架，或按天数。 */
export function getAiSearchScope(): 'active' | 'days' {
  const raw = getRuntimeEnv('AI_SEARCH_SCOPE', 'active').trim();
  return raw === 'days' ? 'days' : 'active';
}

export function getAiSearchRecallLimit(): number {
  return getRuntimeEnvNumber('AI_SEARCH_RECALL_LIMIT', 60, 20, 200);
}

export function getAiSearchRerankLimit(): number {
  return getRuntimeEnvNumber('AI_SEARCH_RERANK_LIMIT', 20, 5, 30);
}

export function getAiSearchRerankEnabled(): boolean {
  return getRuntimeBool('AI_SEARCH_RERANK_ENABLED', true);
}

export function getAiSearchUseSummary(): boolean {
  return getRuntimeBool('AI_SEARCH_USE_SUMMARY', true);
}

/** 是否在生成摘要时顺带产出品类标签。 */
export function getAiTagsEnabled(): boolean {
  return getRuntimeBool('AI_TAGS_ENABLED', true);
}

export function getAiTagsProposeEnabled(): boolean {
  return getRuntimeBool('AI_TAGS_PROPOSE_ENABLED', true);
}

/** 允许 0，表示不提议新标签。 */
export function getAiTagsProposeMax(): number {
  const raw = getRuntimeEnvRaw('AI_TAGS_PROPOSE_MAX');
  if (raw === null || raw.trim() === '') return 2;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return 2;
  return Math.min(Math.round(value), 3);
}

export function getAiTagsPromoteThreshold(): number {
  return getRuntimeEnvNumber('AI_TAGS_PROMOTE_THRESHOLD', 3, 2, 20);
}

export function getAiTagsCandidateLimit(): number {
  return getRuntimeEnvNumber('AI_TAGS_CANDIDATE_LIMIT', 500, 50, 5000);
}

export function getAiTagsBrandExtractEnabled(): boolean {
  return getRuntimeBool('AI_TAGS_BRAND_EXTRACT_ENABLED', true);
}

export function getSearchSuggestTags(): number {
  const raw = getRuntimeEnvRaw('SEARCH_SUGGEST_TAGS');
  if (raw === null || raw.trim() === '') return 6;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return 6;
  return Math.min(Math.round(value), 12);
}

export function getAiSearchRewriteOnEmptyRerank(): boolean {
  return getRuntimeBool('SEARCH_REWRITE_ON_EMPTY_RERANK', true);
}

/** 受控品类标签词表：支持换行、中英文逗号、顿号分隔。 */
export function getAiTagVocabulary(): string[] {
  const raw = getRuntimeEnv('AI_TAG_VOCABULARY', '').trim();
  const source = raw || DEFAULT_TAG_VOCABULARY.join('\n');
  const tags = source
    .split(/[\n,，、;；]+/)
    .map((tag) => tag.trim())
    .filter((tag) => tag.length >= 2 && tag.length <= 12);

  return [...new Set([...tags, ...getPromotedTags()])].slice(0, 200);
}

export function getAiSearchFtsEnabled(): boolean {
  return getRuntimeBool('AI_SEARCH_FTS_ENABLED', true);
}

export function getAiSearchSynonymEnabled(): boolean {
  return getRuntimeBool('AI_SEARCH_SYNONYM_ENABLED', true);
}

export function getAiSearchRewriteEnabled(): boolean {
  return getRuntimeBool('AI_SEARCH_REWRITE_ENABLED', true);
}

export function getAiSearchRewriteTimeoutMs(): number {
  return getRuntimeEnvNumber(
    'AI_SEARCH_REWRITE_TIMEOUT_MS',
    8000,
    2000,
    30000,
  );
}

export function getAiSearchRewritePerMinute(): number {
  return getRuntimeEnvNumber(
    'AI_SEARCH_REWRITE_PER_MINUTE',
    20,
    1,
    200,
  );
}

export function getAiSearchIndexMaxChars(): number {
  return getRuntimeEnvNumber('AI_SEARCH_INDEX_MAX_CHARS', 400, 200, 1000);
}

/** 0 表示不限制，因此不能复用 getRuntimeEnvNumber。 */
export function getAiSearchMaxPerSource(): number {
  const raw = getRuntimeEnvRaw('AI_SEARCH_MAX_PER_SOURCE');
  if (raw === null || raw.trim() === '') return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.round(value), 50);
}

export function getAiSearchModel(): string {
  return getRuntimeEnv('AI_SEARCH_MODEL', '').trim();
}

export function getKeywordSearchMaxResults(): number {
  return getRuntimeEnvNumber('KEYWORD_SEARCH_MAX_RESULTS', 100, 20, 500);
}

const DEFAULT_SITE: SiteSettings = {
  label: 'Daily Deals',
  title: '每日优惠情报',
  tagline: 'AI 精简 · 定时自动聚合 · 只收录真实来源',
};

/** 首页顶部展示文案，后台「站点显示」分组可修改。 */
export function getSiteSettings(): SiteSettings {
  return {
    label: getRuntimeEnv('SITE_LABEL', DEFAULT_SITE.label).trim(),
    title: getRuntimeEnv('SITE_TITLE', DEFAULT_SITE.title).trim(),
    tagline: getRuntimeEnv('SITE_TAGLINE', DEFAULT_SITE.tagline).trim(),
  };
}

/** 站点公开地址，用于生成推送里的详情页链接；未配置时返回空串。 */
export function getSiteUrl(): string {
  const raw = getRuntimeEnv('SITE_URL', '').trim();
  return raw ? raw.replace(/\/+$/, '') : '';
}

/** 是否开放自助注册，默认开放。 */
export function getRegistrationOpen(): boolean {
  return getRuntimeBool('REGISTRATION_OPEN', true);
}

export function getRegistrationInviteCode(): string {
  return getRuntimeEnv('REGISTRATION_INVITE_CODE', '').trim();
}

/** 是否强制使用邀请码注册。 */
export function getRegistrationInviteRequired(): boolean {
  return getRuntimeBool('REGISTRATION_INVITE_REQUIRED', false);
}

/** AI 搜索每日次数；0 表示不限制。 */
export function getAiSearchDailyLimit(): number {
  const raw = getRuntimeEnvRaw('AI_SEARCH_DAILY_LIMIT');
  if (raw === null || raw.trim() === '') return 50;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return 50;
  return Math.min(Math.round(value), 1000);
}

export interface AccountLimitsConfig {
  subscriptions: number;
  channelsPerKind: number;
  dailyPush: number;
}

export function getAccountLimits(): AccountLimitsConfig {
  return {
    subscriptions: getRuntimeEnvNumber('ACCOUNT_MAX_SUBSCRIPTIONS', 20, 1, 200),
    channelsPerKind: getRuntimeEnvNumber(
      'ACCOUNT_MAX_CHANNELS_PER_KIND',
      2,
      1,
      10,
    ),
    dailyPush: getRuntimeEnvNumber('ACCOUNT_DAILY_PUSH_LIMIT', 20, 1, 500),
  };
}

export type NotifyKind = 'wecom' | 'feishu' | 'dingtalk' | 'bark';

export interface NotifyConfig {
  enabled: boolean;
  webhook: string;
  secret: string;
  key: string;
}

/** 后台告警/测试使用的渠道配置；飞书兼容旧告警配置。 */
export function getNotifyConfig(kind: NotifyKind): NotifyConfig {
  if (kind === 'wecom') {
    return {
      enabled: getRuntimeBool('NOTIFY_WECOM_ENABLED', true),
      webhook: getRuntimeEnv('NOTIFY_WECOM_WEBHOOK').trim(),
      secret: '',
      key: '',
    };
  }
  if (kind === 'feishu') {
    return {
      enabled: getRuntimeBool('NOTIFY_FEISHU_ENABLED', true),
      webhook:
        getRuntimeEnv('NOTIFY_FEISHU_WEBHOOK').trim() ||
        getRuntimeEnv('FEISHU_WEBHOOK_URL').trim(),
      secret:
        getRuntimeEnv('NOTIFY_FEISHU_SECRET').trim() ||
        getRuntimeEnv('FEISHU_WEBHOOK_SECRET').trim(),
      key: '',
    };
  }
  if (kind === 'dingtalk') {
    return {
      enabled: getRuntimeBool('NOTIFY_DINGTALK_ENABLED', true),
      webhook: getRuntimeEnv('NOTIFY_DINGTALK_WEBHOOK').trim(),
      secret: getRuntimeEnv('NOTIFY_DINGTALK_SECRET').trim(),
      key: '',
    };
  }
  return {
    enabled: getRuntimeBool('NOTIFY_BARK_ENABLED', true),
    webhook: '',
    secret: '',
    key: getRuntimeEnv('NOTIFY_BARK_KEY').trim(),
  };
}

/** 后台展示用的运行时配置列表；密钥类字段不回传明文。 */
export function getRuntimeAdminFields(): RuntimeSettingView[] {
  return FIELDS.filter((def) => !def.hidden).map((def) => {
    const raw = getRuntimeEnvRaw(def.key);
    const configured = raw !== null && raw.trim() !== '';

    const stored = getSetting(`env:${def.key}`);
    const envValue = process.env[def.key];
    const source: RuntimeSettingView['source'] =
      stored !== null && stored.trim() !== ''
        ? 'admin'
        : envValue !== undefined && envValue.trim() !== ''
          ? 'env'
          : 'default';

    return {
      key: def.key,
      label: def.label,
      group: def.group,
      description: def.description,
      type: def.type,
      value: def.secret ? '' : effectiveValue(def),
      configured,
      secret: def.secret,
      options: def.options,
      restartRequired: def.restartRequired,
      min: def.min,
      max: def.max,
      source,
    };
  });
}

/** 保存后台提交的运行时配置；密钥字段留空时保持原值。 */
export function saveRuntimeSettings(
  values: Record<string, unknown>,
): string | null {
  const writes: [string, string][] = [];

  for (const def of FIELDS) {
    if (!(def.key in values)) continue;

    const raw = values[def.key];
    // 兼容接口直接传数字的情况，避免被当成空值而清掉后台配置。
    const value =
      typeof raw === 'string'
        ? raw.trim()
        : typeof raw === 'number' && Number.isFinite(raw)
          ? String(raw)
          : null;
    if (value === null) continue;

    if (def.secret && value === '') continue;

    if (def.key === 'ADMIN_PASSWORD' && value.length < 4) {
      return '管理后台密码至少 4 位';
    }

    if (
      def.type === 'select' &&
      value !== '' &&
      !(def.options ?? []).some((option) => option.value === value)
    ) {
      return `${def.label}的取值不合法`;
    }

    if (def.type === 'number' && value !== '') {
      const parsed = Number(value);
      const min = def.min ?? 1;
      if (!Number.isFinite(parsed) || parsed < min) {
        return `${def.label}不能小于 ${min}`;
      }
    }

    if (
      (def.key === 'SITE_URL' ||
        def.key === 'LLM_BASE_URL' ||
        def.key === 'OUTBOUND_PROXY' ||
        def.key === 'FEISHU_WEBHOOK_URL' ||
        def.key === 'NOTIFY_WECOM_WEBHOOK' ||
        def.key === 'NOTIFY_FEISHU_WEBHOOK' ||
        def.key === 'NOTIFY_DINGTALK_WEBHOOK') &&
      value !== ''
    ) {
      try {
        const url = new URL(value);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          return `${def.label}必须是 http/https 地址`;
        }
      } catch {
        return `${def.label}格式不正确`;
      }
    }

    if (
      (def.key === 'DIGEST_OVERFLOW_TIME' || def.key === 'DIGEST_SITE_TIME') &&
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)
    ) {
      return `${def.label}格式应为 HH:mm`;
    }

    let normalized = value;
    if (def.type === 'number' && value !== '') {
      const parsed = Number(value);
      normalized = String(
        clamp(
          Math.round(parsed),
          def.min ?? 1,
          def.max ?? Number.MAX_SAFE_INTEGER,
        ),
      );
    }

    writes.push([def.key, normalized]);
  }

  // 全部校验通过后再落库，避免部分字段已保存、后面字段报错。
  for (const [key, value] of writes) {
    setSetting(`env:${key}`, value);
  }

  return null;
}

/** 组装管理后台接口所需的完整数据。 */
export function getAdminPayload(): AdminData {
  return {
    ...getAdminData(),
    globalIntervalMinutes: getGlobalIntervalMinutes(),
    runtimeSettings: getRuntimeAdminFields(),
  };
}
