import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { matches } from "./types.ts";

export function ServicePage({ query }: { query: string }) {
  const [service, setService] = useState<{
    address: string;
    data: string;
    log: string;
  } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api<{ address: string; data: string; log: string }>("/settings/service")
      .then((value) => {
        if (active) setService(value);
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, []);
  const rows = service
    ? [
        ["地址", service.address],
        ["数据目录", service.data],
        ["日志位置", service.log],
      ]
    : [];
  return (
    <div className="space-y-6">
      <h1 className="m-0 text-xl font-medium">服务</h1>
      {error && (
        <p role="alert" className="text-xs text-[#9a5b4b]">
          {error}
        </p>
      )}
      {!service && !error && (
        <p className="text-xs text-muted">正在读取服务信息…</p>
      )}
      {service && (
        <div className="rounded-2xl bg-white px-5 shadow-lift">
          {rows
            .filter(([label, value]) => matches(query, label, value))
            .map(([label, value]) => (
              <div
                key={label}
                className="flex flex-col gap-2 border-b border-line-subtle py-4 last:border-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
              >
                <span className="shrink-0 text-xs text-ink">{label}</span>
                <code className="break-all text-[11px] text-muted sm:text-right">
                  {value}
                </code>
              </div>
            ))}
          {!rows.some(([label, value]) => matches(query, label, value)) && (
            <p className="py-4 text-xs text-muted">没有匹配的设置项</p>
          )}
        </div>
      )}
    </div>
  );
}
