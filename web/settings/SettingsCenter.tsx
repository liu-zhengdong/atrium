import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Bot,
  KeyRound,
  Menu,
  Search,
  Server,
  UserRound,
  X,
} from "lucide-react";
import type { Agent } from "../components/AgentAvatar.tsx";
import { ProfilePage } from "./ProfilePage.tsx";
import { AccountsPage } from "./AccountsPage.tsx";
import { ServicePage } from "./ServicePage.tsx";
import { AgentDefaultsPage } from "./AgentDefaultsPage.tsx";
import type { SettingsPage } from "./types.ts";

const navigation = [
  {
    section: "个人",
    entries: [
      {
        id: "profile" as const,
        label: "个人资料",
        Icon: UserRound,
        terms: "称呼 资料 正文",
      },
      {
        id: "accounts" as const,
        label: "账号",
        Icon: KeyRound,
        terms: "API key OAuth 模型 分配 Agent provider",
      },
    ],
  },
  {
    section: "Agent",
    entries: [
      {
        id: "agent-defaults" as const,
        label: "新 Agent 默认配置",
        Icon: Bot,
        terms: "插件 技能 模型 packages skills",
      },
    ],
  },
  {
    section: "系统",
    entries: [
      {
        id: "service" as const,
        label: "服务",
        Icon: Server,
        terms: "地址 数据目录 日志位置",
      },
    ],
  },
];

export function SettingsCenter({
  page,
  setPage,
  focus,
  agents,
  close,
  openAgent,
  changed,
}: {
  page: SettingsPage;
  setPage: (page: SettingsPage) => void;
  focus: string | null;
  agents: Agent[];
  close: () => void;
  openAgent: (id: string) => void;
  changed: () => void;
}) {
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !document.querySelector(
          '[role="dialog"], [data-radix-popper-content-wrapper]',
        )
      ) {
        event.preventDefault();
        close();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [close]);
  return (
    <div className="flex h-dvh min-h-[380px] flex-col overflow-hidden bg-surface font-sans text-ink sm:flex-row">
      <aside className="shrink-0 px-4 pb-3 pt-5 sm:w-[245px] sm:px-5 sm:pt-6">
        <button
          className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted hover:bg-[#e5ece7] hover:text-ink"
          onClick={close}
        >
          <ArrowLeft size={15} />
          返回应用
        </button>
        <div className="mt-5 flex items-center gap-2 sm:mt-8">
          <div className="relative min-w-0 flex-1">
            <Search
              className="pointer-events-none absolute left-2.5 top-[9px] text-muted"
              size={15}
            />
            <input
              ref={searchRef}
              className="field !border-transparent !bg-[#e9efeb] !pl-8 !pr-8 focus:!border-[#b9c9bd] focus:!bg-white focus:!shadow-none"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="搜索设置"
              placeholder="搜索设置"
            />
            {query && (
              <button
                className="absolute right-2 top-[7px] rounded p-1 text-muted hover:bg-soft"
                aria-label="清除搜索"
                onClick={() => setQuery("")}
              >
                <X size={14} />
              </button>
            )}
          </div>
          <button
            className="icon-button sm:!hidden"
            aria-label="切换设置导航"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(!menuOpen)}
          >
            <Menu size={17} />
          </button>
        </div>
        <nav
          aria-label="设置导航"
          className={`${menuOpen ? "block" : "hidden"} mt-5 space-y-6 sm:block`}
        >
          {navigation.map((group) => {
            const entries = group.entries.filter(
              (item) =>
                !query ||
                `${item.label} ${item.terms}`
                  .toLowerCase()
                  .includes(query.toLowerCase()),
            );
            return entries.length ? (
              <div key={group.section}>
                <p className="mb-2 px-3 text-[11px] text-muted">
                  {group.section}
                </p>
                <div className="space-y-1">
                  {entries.map(({ id, label, Icon }) => (
                    <button
                      key={id}
                      onClick={() => {
                        setPage(id);
                        setMenuOpen(false);
                      }}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs ${page === id ? "bg-[#e2ebe4] text-accent-strong" : "text-muted hover:bg-[#edf3ef] hover:text-ink"}`}
                      aria-current={page === id ? "page" : undefined}
                    >
                      <Icon size={15} />
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null;
          })}
          {query &&
            !navigation.some((group) =>
              group.entries.some((item) =>
                `${item.label} ${item.terms}`
                  .toLowerCase()
                  .includes(query.toLowerCase()),
              ),
            ) && <p className="px-3 text-xs text-muted">无匹配导航</p>}
        </nav>
      </aside>
      <main className="m-2 mt-0 min-w-0 flex-1 overflow-auto rounded-2xl bg-[#fcfdfc] px-5 py-7 shadow-[0_1px_3px_rgba(0,0,0,0.02),0_8px_24px_rgba(0,0,0,0.03)] sm:m-2.5 sm:ml-0 sm:px-8 sm:py-9">
        <div className="mx-auto max-w-[720px]">
          {page === "profile" ? (
            <ProfilePage query={query} changed={changed} />
          ) : page === "accounts" ? (
            <AccountsPage
              agents={agents}
              query={query}
              focus={focus}
              openAgent={openAgent}
            />
          ) : page === "agent-defaults" ? (
            <AgentDefaultsPage query={query} />
          ) : (
            <ServicePage query={query} />
          )}
        </div>
      </main>
    </div>
  );
}
