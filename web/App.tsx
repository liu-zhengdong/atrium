import { useEffect, useState } from "react";
import { ArrowLeft, LoaderCircle, MessageSquare } from "lucide-react";
import { api, patchChat } from "./api.ts";
import { useOverview } from "./useOverview.ts";
import { Empty } from "./components/Empty.tsx";
import type { Agent } from "./components/AgentAvatar.tsx";
import { Sidebar, type Section } from "./layout/Sidebar.tsx";
import { TopBar } from "./layout/TopBar.tsx";
import { AgentDirectory } from "./agents/AgentDirectory.tsx";
import { AgentDrawer } from "./agents/AgentDrawer.tsx";
import { GroupDrawer } from "./groups/GroupDrawer.tsx";
import { CreateAgentDialog } from "./agents/CreateAgentDialog.tsx";
import { ChatView } from "./chat/ChatView.tsx";
import { CreateChatDialog } from "./chat/ChatDialogs.tsx";
import { UserProfileDialog } from "./user/UserProfileDialog.tsx";
import { RecordsView } from "./records/RecordsView.tsx";
import {
  emptyFilters,
  type RecordFilters,
  type RecordTab,
} from "./records/query.ts";

export function App() {
  const {
    overview,
    revision,
    error: loadError,
    connected,
    refresh,
  } = useOverview();
  const [section, setSection] = useState<Section>("chat");
  const [chatId, setChatId] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [modal, setModal] = useState<"agent" | "chat" | "user" | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  // 轨迹抽屉和群信息抽屉共用右侧位置，互斥打开。
  const [groupOpen, setGroupOpen] = useState(false);
  const [openingAgent, setOpeningAgent] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<{
    chatId: string;
    messageId: number;
  } | null>(null);
  // 聊天记录页的筛选放在这里，离开去看一眼会话再回来不用重新选一遍。
  const [recordTab, setRecordTab] = useState<RecordTab>("messages");
  const [recordFilters, setRecordFilters] =
    useState<RecordFilters>(emptyFilters);
  const [error, setError] = useState("");
  const active = overview?.chats.find((chat) => chat.id === chatId);
  const selectedAgent = overview?.agents.find((agent) => agent.id === agentId);

  useEffect(() => {
    if (overview)
      setChatId((current) => current ?? overview.chats[0]?.id ?? null);
  }, [overview]);

  function navigate(next: Section) {
    setSection(next);
    setMobileOpen(false);
  }
  function selectChat(id: string) {
    setAnchor(null);
    setChatId(id);
    navigate("chat");
  }
  /** 从会话进聊天记录：预先把会话筛选选上，其余筛选重置。 */
  function openRecords(scope: string | null) {
    setGroupOpen(false);
    setAgentId(null);
    setRecordFilters({ ...emptyFilters, chat: scope });
    setRecordTab("messages");
    navigate("records");
  }
  /** 搜索结果跳到某条消息：先解除隐藏，再进入会话并定位高亮。 */
  async function openMessage(chat: string, messageId: number) {
    try {
      await patchChat(chat, { hidden: false });
    } catch {
      // 未能解除隐藏也照常打开。
    }
    setChatId(chat);
    setAnchor({ chatId: chat, messageId });
    navigate("chat");
    refresh();
  }
  async function openChat(key: string, path: string, body?: unknown) {
    if (openingAgent) return;
    setOpeningAgent(key);
    setError("");
    try {
      const result = await api<{ id: string }>(path, "POST", body);
      selectChat(result.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setOpeningAgent(null);
      refresh();
    }
  }
  const openAgent = (agent: Agent) =>
    openChat(agent.id, "/chats", {
      name: agent.name,
      members: [agent.id],
      direct_agent: agent.id,
    });

  return (
    <div
      className={`app flex h-dvh min-h-[380px] overflow-hidden bg-surface-subtle font-sans text-ink ${mobileOpen ? "mobile-list" : ""}`}
    >
      <Sidebar
        overview={overview}
        section={section}
        setSection={navigate}
        chatId={chatId}
        selectChat={selectChat}
        create={setModal}
        openAgent={(agent) => void openAgent(agent)}
        openingAgent={openingAgent}
        connected={connected}
        details={setAgentId}
        refresh={refresh}
      />
      <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-surface">
        <TopBar
          overview={overview}
          selectChat={selectChat}
          openAgent={(agent) => void openAgent(agent)}
          openingAgent={openingAgent}
          details={setAgentId}
          refresh={refresh}
          openMessage={(chat, message) => void openMessage(chat, message)}
          openUser={() => setModal("user")}
          toggleMobile={() => setMobileOpen(!mobileOpen)}
        />
        <div className="relative flex min-h-0 flex-1 overflow-hidden">
          <main className="main relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-white">
            <button
              className="mobile-back icon-button"
              aria-label="打开导航"
              onClick={() => setMobileOpen(!mobileOpen)}
            >
              <ArrowLeft size={18} />
            </button>
            {(error || loadError) && (
              <div
                className="mx-6 mt-3 flex items-center justify-between gap-3 rounded-lg border border-[#e2d5c3] bg-[#fbf6ef] px-3.5 py-2.5 text-xs text-[#8f673e]"
                role="alert"
              >
                {error || loadError}
                <button
                  className="underline"
                  onClick={() => {
                    setError("");
                    refresh();
                  }}
                >
                  重试
                </button>
              </div>
            )}
            {!overview ? (
              <Empty
                icon={<LoaderCircle className="spin text-accent" size={24} />}
                title="正在连接中庭"
              >
                <p>读取你的会话与 Agent。</p>
              </Empty>
            ) : (
              <>
                {section === "agents" && (
                  <AgentDirectory
                    overview={overview}
                    opening={openingAgent}
                    openAgent={(agent) => void openAgent(agent)}
                    details={setAgentId}
                    create={() => setModal("agent")}
                  />
                )}
                {section === "records" && (
                  <RecordsView
                    overview={overview}
                    tab={recordTab}
                    setTab={setRecordTab}
                    filters={recordFilters}
                    setFilters={setRecordFilters}
                    openMessage={(chat, message) =>
                      void openMessage(chat, message)
                    }
                  />
                )}
                {section === "chat" && !active && (
                  <Empty
                    icon={<MessageSquare className="text-muted" size={26} />}
                    title="从一段对话开始"
                  >
                    <p>选择一位 Agent，或从左侧打开已有会话。</p>
                    <button
                      className="button"
                      onClick={() => navigate("agents")}
                    >
                      查看 Agent
                    </button>
                  </Empty>
                )}
                {/* Keep the conversation mounted across navigation so per-chat drafts survive. */}
                <ChatView
                  active={active}
                  chatId={chatId}
                  agents={overview.agents}
                  revision={revision}
                  hidden={section !== "chat"}
                  details={setAgentId}
                  refresh={refresh}
                  anchor={anchor}
                  clearAnchor={() => setAnchor(null)}
                  openGroup={() => {
                    setAgentId(null);
                    setGroupOpen(true);
                  }}
                  openRecords={() => openRecords(chatId)}
                />
              </>
            )}
          </main>
          {selectedAgent && (
            <AgentDrawer
              key={selectedAgent.id}
              agent={selectedAgent}
              revision={revision}
              close={() => setAgentId(null)}
              refresh={refresh}
            />
          )}
          {groupOpen && active?.kind === "group" && overview && (
            <GroupDrawer
              key={active.id}
              chat={active}
              agents={overview.agents}
              revision={revision}
              close={() => setGroupOpen(false)}
              changed={refresh}
              openRecords={() => openRecords(active.id)}
              openAgent={(id) => {
                setGroupOpen(false);
                setAgentId(id);
              }}
            />
          )}
        </div>
      </div>
      {modal === "agent" && (
        <CreateAgentDialog
          close={() => setModal(null)}
          desktopsRoot={overview?.desktops_root}
          agents={overview?.agents ?? []}
          created={async (agent, startError) => {
            await openAgent(agent);
            if (startError) setError(startError);
          }}
        />
      )}
      {modal === "user" && overview && (
        <UserProfileDialog
          user={overview.user}
          close={() => setModal(null)}
          saved={refresh}
        />
      )}
      {modal === "chat" && (
        <CreateChatDialog
          agents={overview?.agents ?? []}
          close={() => setModal(null)}
          created={(id) => {
            selectChat(id);
            refresh();
          }}
        />
      )}
    </div>
  );
}
