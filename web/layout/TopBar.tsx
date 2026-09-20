import type { Overview } from "../../shared/schema.ts";
import type { Agent } from "../components/AgentAvatar.tsx";
import { Mark } from "../components/Mark.tsx";
import { GlobalSearch } from "./GlobalSearch.tsx";

export function TopBar({
  overview,
  selectChat,
  openAgent,
  openingAgent,
  details,
  refresh,
  openMessage,
}: {
  overview: Overview | null;
  selectChat: (id: string) => void;
  openAgent: (agent: Agent) => void;
  openingAgent: string | null;
  details: (id: string) => void;
  refresh: () => void;
  openMessage: (chatId: string, messageId: number) => void;
}) {
  return (
    <header
      role="banner"
      className="relative z-20 grid h-[52px] flex-none grid-cols-[minmax(0,1fr)_minmax(240px,560px)_minmax(0,1fr)] items-center gap-3 border-b border-line bg-surface px-3.5 max-[560px]:h-12 max-[560px]:gap-2 max-[560px]:px-2.5"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Mark className="h-[22px] w-[22px] flex-none text-[#72634a]" />
        <span className="truncate text-base font-[620] tracking-[-0.05em] max-[560px]:hidden">
          Atrium
        </span>
        <span className="mt-px text-xs text-[#8e897d] max-[720px]:hidden">
          中庭
        </span>
      </div>
      <GlobalSearch
        overview={overview}
        selectChat={selectChat}
        openAgent={openAgent}
        openingAgent={openingAgent}
        details={details}
        refresh={refresh}
        openMessage={openMessage}
      />
      <div />
    </header>
  );
}
