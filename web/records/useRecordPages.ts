import { useCallback, useEffect, useRef, useState } from "react";
import type { RecordPage } from "../../shared/schema.ts";
import { api } from "../api.ts";
import {
  rangeError,
  recordsPath,
  type RecordFilters,
  type RecordTab,
} from "./query.ts";

/**
 * 一块内容的翻页。筛选一变就从头取；「加载更早的」把上一页最后一条的游标带上。
 * 三块内容的差别只在怎么渲染，取数这件事共用这里。
 */
export function useRecordPages<T>(
  tab: RecordTab,
  filters: RecordFilters,
  cursorOf: (item: T) => number,
) {
  const [items, setItems] = useState<T[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // 筛选改得快时旧请求可能后回来，用序号丢弃过期结果。
  const generation = useRef(0);
  const invalid = rangeError(filters);
  // 用拼好的路径当依赖，而不是 filters 对象：父组件每次渲染都会造一个新对象。
  const first = recordsPath(tab, filters);

  const load = useCallback(async (path: string, append: boolean) => {
    const mine = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const page = await api<RecordPage<T>>(path);
      if (mine !== generation.current) return;
      setItems((old) => (append ? [...old, ...page.items] : page.items));
      setMore(page.has_more);
    } catch (e) {
      if (mine === generation.current) setError(String(e));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (invalid) {
      generation.current += 1;
      setItems([]);
      setMore(false);
      setLoading(false);
      setError(invalid);
      return;
    }
    void load(first, false);
  }, [first, invalid, load]);

  const loadMore = () => {
    const last = items.at(-1);
    if (last && !invalid)
      void load(recordsPath(tab, filters, cursorOf(last)), true);
  };
  return { items, more, loading, error, loadMore };
}
