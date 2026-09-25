import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Search } from "lucide-react";
import {
  matchingProviders,
  type ProviderEntry,
  type ProviderMethod,
} from "../../shared/providers.ts";
import { isImeKey } from "../keys.ts";

export function ProviderPicker({
  method,
  providers,
  search,
  setSearch,
  choose,
  changeMethod,
  accounts,
  error,
  retry,
}: {
  method: ProviderMethod;
  providers: ProviderEntry[] | null;
  search: string;
  setSearch: (search: string) => void;
  choose: (provider: ProviderEntry) => void;
  changeMethod: (method: ProviderMethod) => void;
  accounts: { provider: string; status: string }[];
  error: string;
  retry: () => void;
}) {
  const available = error
    ? []
    : matchingProviders(providers ?? [], method, search);
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => setActive(0), [method, search]);
  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (isImeKey(event.nativeEvent)) return;
    if (!available.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next =
        (active + (event.key === "ArrowDown" ? 1 : -1) + available.length) %
        available.length;
      setActive(next);
      list.current
        ?.querySelectorAll("[role=option]")
        [next]?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(available[active] ?? available[0]!);
    }
  }
  const other = providers?.find(
    (provider) =>
      search.trim() &&
      !provider.methods.includes(method) &&
      `${provider.name} ${provider.id}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <div className="mt-5">
      <div className="relative">
        <Search
          size={16}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-muted"
        />
        <input
          autoFocus
          className="field !border-transparent !bg-[#f1f5f2] !pl-9 focus:!border-[#b9c9bd] focus:!bg-white focus:!shadow-none"
          role="combobox"
          aria-controls="connect-provider-list"
          aria-expanded="true"
          aria-label="筛选供应商"
          placeholder="搜索供应商"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={keyDown}
        />
      </div>
      <div
        ref={list}
        id="connect-provider-list"
        className={`mt-2 h-[320px] space-y-0.5 overflow-y-auto ${error || (providers && !available.length) ? "flex items-center justify-center" : ""}`}
        role="listbox"
        aria-label="供应商"
      >
        {!providers && !error && (
          <p className="px-3 py-4 text-xs text-muted">正在加载…</p>
        )}
        {error && (
          <div className="px-3 py-4 text-xs text-[#9a5b4b]" role="alert">
            {error}{" "}
            <button type="button" className="underline" onClick={retry}>
              重试
            </button>
          </div>
        )}
        {providers && !error && !available.length && (
          <div className="px-3 py-4 text-xs text-muted">
            {other ? (
              <>
                {other.name} 只支持{" "}
                {other.methods.includes("api_key") ? "API Key" : "账号登录"}。{" "}
                <button
                  className="text-accent-strong underline"
                  type="button"
                  onClick={() => changeMethod(other.methods[0]!)}
                >
                  改用 {other.methods[0] === "api_key" ? "API Key" : "账号登录"}
                </button>
              </>
            ) : (
              "没有匹配的供应商"
            )}
          </div>
        )}
        {available.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="option"
            aria-selected={active === index}
            className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm ${active === index ? "bg-[#edf3ee]" : "hover:bg-[#f1f5f2]"}`}
            onMouseEnter={() => setActive(index)}
            onClick={() => choose(item)}
          >
            <span className="min-w-0 truncate">
              {item.name}
              {accounts.some((account) => account.provider === item.id) && (
                <span className="ml-2 text-xs text-muted">已有账号</span>
              )}
            </span>
            <span className="shrink-0 text-xs text-muted">{item.id}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
