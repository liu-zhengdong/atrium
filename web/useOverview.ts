import { useCallback, useEffect, useState } from "react";
import type { Overview } from "../shared/schema.ts";
import { api } from "./api.ts";

/** One overview subscription shared by navigation and domain views. */
export function useOverview() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [revision, setRevision] = useState(0),
    [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    void api<Overview>("/overview")
      .then((data) => {
        if (!cancelled) {
          setOverview(data);
          setError("");
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [revision]);

  useEffect(() => {
    const source = new EventSource("/api/events");
    let timer: ReturnType<typeof setTimeout> | undefined;
    source.onopen = () => {
      setConnected(true);
      refresh();
    };
    source.onerror = () => setConnected(false);
    source.addEventListener("change", () => {
      clearTimeout(timer);
      timer = setTimeout(refresh, 80);
    });
    return () => {
      clearTimeout(timer);
      source.close();
    };
  }, [refresh]);

  return { overview, revision, error, connected, refresh };
}
