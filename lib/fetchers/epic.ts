import { fetchText } from '../http';
import { stripHtml } from '../rss';
import { SOURCE_TIMEOUT_MS } from '../sources';
import { truncateText } from '../utils';
import type { RawDeal } from './types';

const DEFAULT_EPIC_URL =
  'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=zh-CN&country=CN&allowCountries=CN';

interface EpicDiscountSetting {
  discountPercentage?: number | string | null;
}

interface EpicOffer {
  startDate?: string | null;
  endDate?: string | null;
  discountSetting?: EpicDiscountSetting | null;
}

interface EpicOfferGroup {
  promotionalOffers?: EpicOffer[] | null;
}

interface EpicPromotions {
  promotionalOffers?: EpicOfferGroup[] | null;
}

interface EpicMapping {
  pageSlug?: string | null;
}

interface EpicElement {
  title?: string | null;
  description?: string | null;
  productSlug?: string | null;
  urlSlug?: string | null;
  catalogNs?: { mappings?: EpicMapping[] | null } | null;
  promotions?: EpicPromotions | null;
}

interface EpicResponse {
  data?: {
    Catalog?: {
      searchStore?: {
        elements?: EpicElement[] | null;
      } | null;
    } | null;
  } | null;
}

function activeFreeOffer(
  element: EpicElement,
  now: number,
): EpicOffer | null {
  const groups = element.promotions?.promotionalOffers ?? [];

  for (const group of groups) {
    for (const offer of group?.promotionalOffers ?? []) {
      if (Number(offer?.discountSetting?.discountPercentage) !== 0) continue;

      const start = offer.startDate ? Date.parse(offer.startDate) : NaN;
      const end = offer.endDate ? Date.parse(offer.endDate) : NaN;
      if (Number.isNaN(start) || Number.isNaN(end)) continue;

      if (start <= now && now <= end) return offer;
    }
  }

  return null;
}

function pickSlug(element: EpicElement): string | null {
  const candidates = [
    element.productSlug,
    element.urlSlug,
    element.catalogNs?.mappings?.[0]?.pageSlug,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const cleaned = candidate.trim().replace(/^\/+/, '').replace(/\/home$/i, '');
    if (cleaned) return cleaned;
  }

  return null;
}

export async function fetchEpicGames(
  url: string = DEFAULT_EPIC_URL,
  sourceId = 'epic',
): Promise<RawDeal[]> {
  const body = await fetchText(
    url,
    { headers: { Accept: 'application/json' } },
    SOURCE_TIMEOUT_MS,
  );

  let payload: EpicResponse;
  try {
    payload = JSON.parse(body) as EpicResponse;
  } catch {
    throw new Error('Epic 返回的不是有效 JSON');
  }

  const elements = payload.data?.Catalog?.searchStore?.elements ?? [];
  const now = Date.now();
  const seen = new Set<string>();
  const deals: RawDeal[] = [];

  for (const element of elements) {
    if (!element?.title) continue;

    const offer = activeFreeOffer(element, now);
    if (!offer) continue;

    const slug = pickSlug(element);
    if (!slug) continue;

    const link = `https://store.epicgames.com/zh-CN/p/${slug}`;
    if (seen.has(link)) continue;
    seen.add(link);

    deals.push({
      title: stripHtml(element.title),
      link,
      description: truncateText(stripHtml(element.description ?? ''), 220),
      publishedAt: null,
      expiresAt: offer.endDate
        ? new Date(offer.endDate).toISOString()
        : null,
      // Epic 来源无论标题是否含关键词，一律归入「游戏」。
      category: 'game',
      source: sourceId,
    });
  }

  return deals;
}
