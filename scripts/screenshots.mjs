// 重新生成 README 用的界面截图。
// 用法：SITE_BASE=https://example.com CHROME_PATH=/path/to/chrome node scripts/screenshots.mjs
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';

const BASE = (process.env.SITE_BASE || 'https://ym.996898.xyz').replace(/\/$/, '');
const OUT = 'screenshots';
const CHROME = process.env.CHROME_PATH || undefined;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function firstMatch(url, re) {
  try {
    const html = await (await fetch(url)).text();
    const m = html.match(re);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function toPath(value, fallback) {
  if (!value) return fallback;
  try {
    const url = new URL(value, BASE);
    // 只保留 pathname，避免与 SITE_BASE 拼接重复
    return url.pathname + url.search;
  } catch {
    return fallback;
  }
}

const dealPath = toPath(
  await firstMatch(`${BASE}/feed.xml`, /<link>([^<]*\/deal\/\d+)<\/link>/),
  '/',
);
const digestPath = toPath(await firstMatch(BASE, /(\/digest\/\d{4}-\d{2}-\d{2})/), null);

const shots = [
  { name: 'desktop-home', path: '/', width: 1440, height: 900, scale: 1 },
  { name: 'desktop-search', path: `/search?q=${encodeURIComponent('云服务器')}`, width: 1440, height: 900, scale: 1 },
  { name: 'desktop-tag', path: `/tag/${encodeURIComponent('服饰')}`, width: 1440, height: 900, scale: 1 },
  { name: 'desktop-deal', path: dealPath, width: 1440, height: 900, scale: 1 },
  ...(digestPath ? [{ name: 'desktop-digest', path: digestPath, width: 1440, height: 900, scale: 1 }] : []),
  { name: 'mobile-home', path: '/', width: 390, height: 844, scale: 2, mobile: true },
  { name: 'mobile-deal', path: dealPath, width: 390, height: 844, scale: 2, mobile: true },
];

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--lang=zh-CN'],
});

for (const shot of shots) {
  const context = await browser.newContext({
    viewport: { width: shot.width, height: shot.height },
    deviceScaleFactor: shot.scale,
    isMobile: Boolean(shot.mobile),
    hasTouch: Boolean(shot.mobile),
    locale: 'zh-CN',
    colorScheme: 'light',
  });
  const page = await context.newPage();
  // 预置偏好与筛选缓存，避免首次访问弹出「选择感兴趣的品类」遮罩
  await page.addInitScript(() => {
    try {
      localStorage.setItem(
        'daily-deals.preferences.v1',
        JSON.stringify({
          tags: ['服饰', '日用', '零食', 'AI工具', '生鲜'],
          chosenAt: '2026-01-01T00:00:00.000Z',
        }),
      );
      localStorage.setItem(
        'daily-deals.filters.v1',
        JSON.stringify({ sources: [], favoritesOnly: false, preferencesOnly: false }),
      );
    } catch {
      // 忽略存储不可用
    }
  });
  const url = `${BASE}${shot.path}`;
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  } catch {
    // 站点较慢时降级为 domcontentloaded，截图仍可继续
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  await sleep(1200);

  if (shot.scrollTo) {
    await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), shot.scrollTo);
    await sleep(900);
  }

  await page.screenshot({ path: `${OUT}/${shot.name}.png` });
  console.log(`saved ${OUT}/${shot.name}.png  <- ${url}`);
  await context.close();
}

await browser.close();
