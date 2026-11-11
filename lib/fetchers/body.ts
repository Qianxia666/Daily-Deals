import { decodeEntities } from '../rss';

const MAX_BODY_CHARS = 8_000;

function stripNoise(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

/** 统一的正文清洗：换行、去标签、解码实体、压缩空行。 */
export function cleanBody(fragment: string): string {
  return decodeEntities(
    stripNoise(fragment)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h\d|tr|blockquote)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_BODY_CHARS);
}

/** 标题取正文首行，去掉话题符号后截断 40 字。 */
export function titleFromBody(text: string): string | null {
  const firstLine = text.split('\n')[0]?.trim() ?? '';
  const cleaned = firstLine
    .replace(/^[#\s]+|[#\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return null;
  return cleaned.length > 40 ? `${cleaned.slice(0, 40)}…` : cleaned;
}

/**
 * 截取一个 div 容器的内容。正则无法可靠处理嵌套，这里按标签深度配对。
 * openTag 需要匹配到开始标签本身。
 */
function sliceDiv(html: string, openTag: RegExp): string | null {
  const match = openTag.exec(html);
  if (!match) return null;

  const start = match.index + match[0].length;
  const tags = /<div\b[^>]*>|<\/div>/gi;
  tags.lastIndex = start;

  let depth = 1;
  let current: RegExpExecArray | null;
  while ((current = tags.exec(html))) {
    depth += current[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return html.slice(start, current.index);
  }

  return html.slice(start);
}

/**
 * 按来源类型提取详情页正文，提取不到返回 null。
 * - sina_weibo：新浪新闻的微博镜像，正文在 article.article-content。
 * - xianbao：线报酷主题，正文在 div.article-content；微博分类的真实内容
 *   常在「关联内容」块里，这里保留其文字和链接，只去掉带时间的标题行。
 */
export function extractBody(kind: string, html: string): string | null {
  if (kind === 'sina_weibo') {
    // 站点可能给同一元素追加其他类名，这里用包含匹配而不是全等。
    const article = html.match(
      /<article\b[^>]*class="[^"]*\barticle-content\b[^"]*"[^>]*>([\s\S]*?)<\/article>/i,
    )?.[1];

    const text = article
      ? cleanBody(article)
          // 正文尾部是「发布于 广东」与互动按钮，截断掉。
          .replace(/\n*发布于[\s\S]*$/i, '')
          .trim()
      : '';

    return text || null;
  }

  if (kind === 'xianbao') {
    const inner = sliceDiv(
      html,
      /<div[^>]*class="[^"]*\barticle-content\b[^"]*"[^>]*>/i,
    );
    if (!inner) return null;

    const text = cleanBody(
      inner.replace(
        /<div[^>]*class="[^"]*\bg-biaoti\b[^"]*"[^>]*>[\s\S]*?<\/div>/gi,
        '',
      ),
    );

    return text || null;
  }

  return null;
}
