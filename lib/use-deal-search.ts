'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type SearchMode = 'ai' | 'keyword';

/** 首页跳转 /search 时暂存关键词，避免把中文放进 URL。 */
export const PENDING_SEARCH_KEY = 'daily-deals.pending-search';

export interface DealSearchResult {
  ids: number[];
  reason: string;
  mode: SearchMode;
  windowDays?: number;
  suggestedTags: { tag: string; count: number }[];
  truncated?: boolean;
}

/** 调用 /api/search，首页与 /search 共用同一套解析与校验。 */
async function requestDealSearch(
  query: string,
  mode: SearchMode,
  tag: string | undefined,
  signal: AbortSignal,
): Promise<DealSearchResult> {
  const response = await fetch('/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, mode, tag }),
    signal,
  });

  const payload = (await response.json().catch(() => null)) as {
    ids?: unknown;
    reason?: unknown;
    mode?: unknown;
    windowDays?: unknown;
    suggestedTags?: unknown;
    truncated?: unknown;
    error?: unknown;
  } | null;

  if (!response.ok) {
    throw new Error(
      typeof payload?.error === 'string'
        ? payload.error
        : `HTTP ${response.status}`,
    );
  }

  const ids = Array.isArray(payload?.ids)
    ? payload.ids.filter((value): value is number => Number.isInteger(value))
    : [];

  const suggestedTags = Array.isArray(payload?.suggestedTags)
    ? payload.suggestedTags
        .filter(
          (value): value is { tag: string; count: number } =>
            Boolean(value) &&
            typeof value === 'object' &&
            typeof (value as { tag?: unknown }).tag === 'string' &&
            typeof (value as { count?: unknown }).count === 'number',
        )
        .slice(0, 12)
    : [];

  return {
    ids,
    reason: typeof payload?.reason === 'string' ? payload.reason : '',
    mode: payload?.mode === 'ai' ? 'ai' : 'keyword',
    windowDays:
      typeof payload?.windowDays === 'number' ? payload.windowDays : undefined,
    suggestedTags,
    truncated: payload?.truncated === true,
  };
}

export function useDealSearch() {
  const [result, setResult] = useState<DealSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const search = useCallback(
    async (
      query: string,
      mode: SearchMode,
      tag?: string,
    ): Promise<DealSearchResult | null> => {
      const trimmed = query.trim();
      if (!trimmed) return null;

      const seq = seqRef.current + 1;
      seqRef.current = seq;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setSearching(true);
      setError(null);

      try {
        const next = await requestDealSearch(
          trimmed,
          mode,
          tag,
          controller.signal,
        );
        if (seq !== seqRef.current) return null;
        setResult(next);
        return next;
      } catch (cause) {
        if (controller.signal.aborted || seq !== seqRef.current) return null;
        setError(
          cause instanceof Error ? cause.message : '搜索失败，请稍后重试',
        );
        return null;
      } finally {
        if (seq === seqRef.current) setSearching(false);
      }
    },
    [],
  );

  const clear = useCallback(() => {
    abortRef.current?.abort();
    seqRef.current += 1;
    setResult(null);
    setSearching(false);
    setError(null);
  }, []);

  return { result, searching, error, search, clear };
}
