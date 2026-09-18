import { useEffect, useState } from "react";
import { ArrowLeft, LoaderCircle, MessageSquare } from "lucide-react";
import { api } from "./api.ts";
import { useOverview } from "./useOverview.ts";
import { Empty } from "./components/Empty.tsx";
import type { Agent } from "./components/AgentAvatar.tsx";
import { Sidebar, type Section } from "./layout/Sidebar.tsx";
import { AgentDirectory } from "./agents/AgentDirectory.tsx";
import { AgentDrawer } from "./agents/AgentDrawer.tsx";
import { CreateAgentDialog } from "./agents/CreateAgentDialog.tsx";
import { ChatView } from "./chat/ChatView.tsx";
import { CreateChatDialog } from "./chat/ChatDialogs.tsx";
import { Integrations } from "./events/Integrations.tsx";

export function App() {
  const {
    overview,
    revision,
    error: loadError,
    connected,
    refresh,
  } = useOverview();
  const [section, setSection] = useState<Section>("agents");
  const [chatId, setChatId] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [modal, setModal] = useState<"agent" | "chat" | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [openingAgent, setOpeningAgent] = useState<string | null>(null);
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
    setChatId(id);
    navigate("chat");
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
    <div className={`app ${mobileOpen ? "mobile-list" : ""}`}>
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
      />
      <main className="main">
        <button
          className="mobile-back icon-button"
          aria-label="打开导航"
          onClick={() => setMobileOpen(!mobileOpen)}
        >
          <ArrowLeft size={20} />
        </button>
        {(error || loadError) && (
          <div className="global-error" role="alert">
            {error || loadError}
            <button
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
            icon={<LoaderCircle className="spin" size={26} />}
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
            {section === "events" && (
              <Integrations
                overview={overview}
                revision={revision}
                refresh={refresh}
              />
            )}
            {section === "chat" && !active && (
              <Empty icon={<MessageSquare size={26} />} title="从一段对话开始">
                <p>选择一位 Agent，或从左侧打开已有会话。</p>
                <button className="button" onClick={() => navigate("agents")}>
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
      {modal === "agent" && (
        <CreateAgentDialog
          close={() => setModal(null)}
          created={async (agent, startError) => {
            await openAgent(agent);
            if (startError) setError(startError);
          }}
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
