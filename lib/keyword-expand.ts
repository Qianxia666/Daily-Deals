/**
 * 订阅关键词扩展与归一化。
 *
 * 方向是单向的，两类词分开处理：
 * - 品类词（奶茶、咖啡）→ 额外覆盖该品类下的常见品牌，让只订品类的人也能收到具体品牌
 * - 品牌词（喜茶、瑞幸）→ 只覆盖同品牌的别名，不会扩散到整个品类
 *
 * 品牌列表只放掉头明确的专有品牌，避免「皇家小虎」「渴望炸鸡」这类同名撞车。
 */

const CATEGORY_BRANDS: Record<string, string[]> = {
  奶茶: [
    '喜茶',
    '霸王茶姬',
    '书亦',
    '蜜雪冰城',
    '益禾堂',
    '古茗',
    '茶百道',
    '沪上阿姨',
    '奈雪',
    '茶颜悦色',
    '茉莉奶白',
    '爷爷不泡茶',
    '新时沏',
  ],
  咖啡: ['瑞幸', '库迪', '星巴克', 'manner', '挪瓦', '幸运咖', 'tims'],
  羽绒服: ['波司登', '鸭鸭', '雪中飞', '高梵', '雅鹿'],
  洗发水: ['海飞丝', '潘婷', '清扬', '沙宣', '卡诗', '滋源', '阿道夫'],
  猫粮: ['麦富迪', '高爷家', '卫仕', '爱肯拿'],
  奶粉: ['爱他美', '飞鹤', '君乐宝', '惠氏', '美赞臣', 'a2'],
  牛奶: ['伊利', '蒙牛', '德运', '认养一头牛'],
  零食: ['三只松鼠', '良品铺子', '百草味', '来伊份'],
  白酒: ['茅台', '五粮液', '泸州老窖', '洋河', '汾酒', '剑南春'],
  运动鞋: ['耐克', '阿迪达斯', '斯凯奇', '安踏', '李宁', '新百伦', '彪马'],
};

/** 同一组内的词互为别名（英文名、简称、俗称）。 */
const ALIAS_GROUPS: string[][] = [
  ['喜茶', 'heytea'],
  ['瑞幸', 'luckin', '小蓝杯'],
  ['星巴克', 'starbucks'],
  ['肯德基', 'kfc', '开封菜'],
  ['麦当劳', 'mcdonald', '金拱门'],
  ['山姆', "sam's club", 'sam club', 'samsclub'],
  ['盒马', 'freshippo'],
  ['耐克', 'nike'],
  ['阿迪达斯', 'adidas'],
  ['斯凯奇', 'skechers'],
  ['优衣库', 'uniqlo'],
  ['名创优品', 'miniso'],
  ['霸王茶姬', 'chagee'],
];

function normalize(text: string): string {
  return text
    .replace(/[\uFF01-\uFF5E]/g, (char) =>
      String.fromCharCode(char.charCodeAt(0) - 0xfee0),
    )
    .replace(/\u3000/g, ' ')
    .toLowerCase()
    .trim();
}

const categoryIndex = new Map<string, string[]>();
for (const [category, brands] of Object.entries(CATEGORY_BRANDS)) {
  categoryIndex.set(normalize(category), brands.map(normalize));
}

const aliasIndex = new Map<string, string[]>();
for (const group of ALIAS_GROUPS) {
  const words = group.map(normalize);
  for (const word of words) {
    aliasIndex.set(
      word,
      words.filter((other) => other !== word),
    );
  }
}

/**
 * 返回关键词的全部匹配形式：自身 + 品类下的品牌 + 品牌别名。
 * 品牌词不会反向扩展到品类，避免「订喜茶收到所有奶茶」。
 */
export function expandKeyword(keyword: string): string[] {
  const key = normalize(keyword);
  if (!key) return [];

  const forms = new Set<string>([key]);

  for (const alias of aliasIndex.get(key) ?? []) forms.add(alias);

  for (const brand of categoryIndex.get(key) ?? []) {
    forms.add(brand);
    for (const alias of aliasIndex.get(brand) ?? []) forms.add(alias);
  }

  return [...forms];
}

/** 该关键词是否配置了扩展（品类词或别名组），用于后台提示。 */
export function hasExpansion(keyword: string): boolean {
  const key = normalize(keyword);
  return categoryIndex.has(key) || aliasIndex.has(key);
}
