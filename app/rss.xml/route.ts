/**
 * /rss.xml 与 /feed.xml 输出完全一致，方便不同订阅器/平台识别。
 * 内容为动态生成：每次请求读取数据库里最新的 50 条在架优惠，
 * 响应头带 max-age=600，最多 10 分钟刷新一次。
 */
export { dynamic, GET } from '../feed.xml/route';
