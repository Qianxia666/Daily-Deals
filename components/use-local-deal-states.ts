'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export const LOCAL_STATES_KEY = 'daily-deals.local-states.v1';

export interface LocalDealState {
  favorite?: boolean;
}

export type LocalDealStates = Record<number, LocalDealState>;

export function parseLocalStates(raw: string): LocalDealStates {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object') return {};

  const result: LocalDealStates = {};
  for (const [key, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    const id = Number(key);
    if (!Number.isInteger(id) || !value || typeof value !== 'object') continue;

    const record = value as Record<string, unknown>;
    const entry: LocalDealState = {};
    if (typeof record.favorite === 'boolean') {
      entry.favorite = record.favorite;
    }
    if (entry.favorite !== undefined) {
      result[id] = entry;
    }
  }

  return result;
}

/** 收藏状态只存在当前浏览器，首页与 /search 共用同一份数据。 */
export function useLocalDealStates() {
  const [states, setStates] = useState<LocalDealStates>({});
  const [ready, setReady] = useState(false);
  const statesRef = useRef<LocalDealStates>({});

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LOCAL_STATES_KEY);
      if (raw) {
        const parsed = parseLocalStates(raw);
        statesRef.current = parsed;
        setStates(parsed);
      }
    } catch {
      // 忽略损坏的本地缓存。
    }
    setReady(true);
  }, []);

  const setFavorite = useCallback((id: number, favorite: boolean) => {
    const next = {
      ...statesRef.current,
      [id]: { ...(statesRef.current[id] ?? {}), favorite },
    };
    statesRef.current = next;
    setStates(next);

    try {
      localStorage.setItem(LOCAL_STATES_KEY, JSON.stringify(next));
    } catch {
      // 浏览器禁用存储时仅当前页面生效。
    }
  }, []);

  const favoriteIds = useCallback(
    () =>
      Object.entries(statesRef.current)
        .filter(([, state]) => state.favorite)
        .map(([id]) => Number(id)),
    [],
  );

  return { states, statesRef, ready, setFavorite, favoriteIds };
}
