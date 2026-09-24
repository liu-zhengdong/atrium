import { useCallback, useEffect, useRef, useState } from "react";
import { api, messageOf } from "../api.ts";
import type { Account } from "./types.ts";

export function useAccounts() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const reload = useCallback(async () => {
    try {
      setAccounts(await api<Account[]>("/accounts"));
      setError("");
    } catch (e) {
      setError(messageOf(e));
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  async function change<T>(task: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError("");
    try {
      const value = await task();
      await reload();
      return value;
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  return { accounts, error, busy, reload, change, setError };
}

export type LoginEvent = {
  type?: string;
  url?: string;
  userCode?: string;
  verificationUri?: string;
  message?: string;
  prompt?: {
    type: string;
    message: string;
    options?: { id: string; label: string }[];
  };
};

export function useLogin(id: string | null, finished: () => void) {
  const [events, setEvents] = useState<LoginEvent[]>([]);
  const [status, setStatus] = useState("pending");
  const [error, setError] = useState("");
  const onFinished = useRef(finished);
  onFinished.current = finished;
  useEffect(() => {
    if (!id) return;
    let active = true,
      after = 0;
    setEvents([]);
    setStatus("pending");
    async function poll() {
      try {
        const result = await api<{
          events: LoginEvent[];
          next: number;
          done: boolean;
          status: string;
        }>(`/accounts/${id}/login?after=${after}`);
        if (!active) return;
        after = result.next;
        setEvents((previous) => [...previous, ...result.events]);
        setStatus(result.status);
        if (result.done) {
          if (result.status === "ready") onFinished.current();
          return;
        }
      } catch (e) {
        if (active) setError(messageOf(e));
      }
      if (active) timer = window.setTimeout(() => void poll(), 900);
    }
    let timer = window.setTimeout(() => void poll(), 0);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [id]);
  async function answer(value: string | null) {
    if (!id) return;
    try {
      await api(`/accounts/${id}/login/answer`, "POST", { value });
      setError("");
    } catch (e) {
      setError(messageOf(e));
    }
  }
  return { events, status, error, answer };
}
