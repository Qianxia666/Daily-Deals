'use client';

import { useEffect, useMemo, useState } from 'react';
import type { DealItem } from '@/lib/types';
import { DealCard } from './deal-card';

/** 按断点决定瀑布流列数：移动端 1 列、md 2 列、2xl 3 列。 */
function useColumnCount(): number {
  const [count, setCount] = useState(1);

  useEffect(() => {
    const md = window.matchMedia('(min-width: 768px)');
    const wide = window.matchMedia('(min-width: 1536px)');

    const update = () => {
      setCount(wide.matches ? 3 : md.matches ? 2 : 1);
    };

    update();
    md.addEventListener('change', update);
    wide.addEventListener('change', update);
    return () => {
      md.removeEventListener('change', update);
      wide.removeEventListener('change', update);
    };
  }, []);

  return count;
}

export function DealMasonry({
  items,
  highlight,
  onToggleFavorite,
  onTagClick,
}: {
  items: DealItem[];
  highlight?: string;
  onToggleFavorite: (id: number) => void;
  onTagClick?: (tag: string) => void;
}) {
  const columnCount = useColumnCount();

  // 轮流分配，保证首屏横向仍是从新到旧；追加数据时已有卡片不会被重新洗牌。
  const columns = useMemo(() => {
    const buckets: DealItem[][] = Array.from(
      { length: columnCount },
      () => [],
    );
    items.forEach((item, index) => {
      buckets[index % columnCount].push(item);
    });
    return buckets;
  }, [items, columnCount]);

  return (
    <div className="flex items-start gap-3">
      {columns.map((column, columnIndex) => (
        <div
          key={columnIndex}
          className="flex min-w-0 flex-1 flex-col gap-3"
        >
          {column.map((item) => (
            <DealCard
              key={item.id}
              item={item}
              highlight={highlight}
              onToggleFavorite={() => onToggleFavorite(item.id)}
              onTagClick={onTagClick}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
