import type { SourceKind } from '../types';
import { fetchEpicGames } from './epic';
import { fetchLinuxDo } from './linuxdo';
import { fetchRssSource } from './rss';
import { fetchSinaWeibo } from './sina-weibo';
import type { RawDeal } from './types';
import { fetchXianbao } from './xianbao';

export interface FetchableSource {
  id: string;
  name: string;
  url: string;
  kind: string;
}

export async function fetchSource(config: FetchableSource): Promise<RawDeal[]> {
  const kind = config.kind as SourceKind;

  switch (kind) {
    case 'linuxdo':
      return fetchLinuxDo(config.url, config.id);
    case 'epic':
      return fetchEpicGames(config.url, config.id);
    case 'xianbao':
      return fetchXianbao(config.url, config.id);
    case 'sina_weibo':
      return fetchSinaWeibo(config.url, config.id);
    case 'rss':
    default:
      return fetchRssSource(config);
  }
}
