import type { ChatReadState, Message } from "../../shared/schema.ts";
import type { Agent } from "../components/AgentAvatar.tsx";

export function ReadReceipt({
  message,
  state,
  agents,
  direct,
}: {
  message: Message;
  state: ChatReadState[];
  agents: Agent[];
  direct: boolean;
}) {
  const readers = state
    .filter((reader) => reader.agent_id !== message.sender)
    .map((reader) => ({
      id: reader.agent_id,
      name:
        agents.find((agent) => agent.id === reader.agent_id)?.name ?? "Agent",
      read:
        message.id <= reader.through ||
        reader.ranges.some(
          (range) => message.id >= range.first && message.id <= range.last,
        ),
    }));
  if (!readers.length) return null;
  const seen = readers.filter((reader) => reader.read);
  const explanation =
    "已读表示 Agent 通过工具取回了正文，不代表已处理。通知、投递和用户查看不算已读。";
  if (direct)
    return (
      <p className="read-receipt" title={explanation}>
        {seen.length ? "已读" : "未读"}
      </p>
    );
  const label = !seen.length
    ? "未读"
    : readers.length <= 2
      ? `已读：${seen.map((reader) => reader.name).join("、")}`
      : `已读 ${seen.length}/${readers.length}`;
  return (
    <details className="read-receipt">
      <summary aria-label={`查看消息 ${message.id} 的已读状态`}>
        {label}
      </summary>
      <div className="receipt-details">
        <div className="receipt-list">
          <section>
            <h3>已读 {seen.length}</h3>
            {seen.length ? (
              seen.map((reader) => <span key={reader.id}>{reader.name}</span>)
            ) : (
              <span className="muted">暂无</span>
            )}
          </section>
          <section>
            <h3>未读 {readers.length - seen.length}</h3>
            {readers.some((reader) => !reader.read) ? (
              readers
                .filter((reader) => !reader.read)
                .map((reader) => <span key={reader.id}>{reader.name}</span>)
            ) : (
              <span className="muted">暂无</span>
            )}
          </section>
        </div>
        <p>{explanation}</p>
      </div>
    </details>
  );
}
