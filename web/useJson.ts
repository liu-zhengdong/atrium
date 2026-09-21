import { useEffect, useState } from "react";
import { api } from "./api.ts";

/** 一次 GET 的加载态；path 为 null 表示这次不请求。 */
export function useJson<T>(path: string | null, revision = 0) {
  const [state, setState] = useState<{
    data?: T;
    error?: string;
    loading: boolean;
  }>({ loading: !!path });
  useEffect(() => {
    if (!path) {
      setState({ loading: false });
      return;
    }
    let alive = true;
    setState({ loading: true });
    api<T>(path).then(
      (data) => alive && setState({ data, loading: false }),
      (error) => alive && setState({ error: String(error), loading: false }),
    );
    return () => {
      alive = false;
    };
  }, [path, revision]);
  return state;
}
