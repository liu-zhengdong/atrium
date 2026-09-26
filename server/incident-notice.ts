import { LOCAL_USER } from "../shared/user.ts";
import { retryDecision } from "./incident.ts";
import type { Store } from "./store.ts";

type Waiting = {
  sender: string;
  chat_id: string;
  kind: string;
  message_id: number;
};
type Recipient = {
  recipient: string;
  chat_id: string | null;
  last_chat: string | null;
};

const headline = (text: string) =>
  text.split(/\r?\n/, 1)[0]!.trim().slice(0, 60);
export const instruction = (text: string, ref: string) => {
  if (/\b400\b[^\n]{0,160}Invalid request parameters/i.test(text))
    return `下一步：atrium new-session ${ref}；旧会话文件会保留。`;
  if (
    /(?:usage|quota|rate|monthly|daily|5.hour) limit|insufficient_quota|no remaining credits|credit balance|额度|用量|余额不足|套餐.*用尽/i.test(
      text,
    )
  )
    return "下一步：等额度恢复或改分配账号，修好后点击重试。";
  if (/not logged in|keychain|钥匙串|please run \/login/i.test(text))
    return "下一步：在运行这台 Mac 上允许钥匙串访问；也可以按长期令牌方案重新登录。";
  if (
    /api[ _-]*key|\b401\b|invalid[ _-]*key|模型认证失败|authentication failed/i.test(
      text,
    )
  )
    return "下一步：更换 API Key 或改分配账号，修好后点击重试。";
  return "下一步：检查模型账号与运行配置，修好后点击重试。";
};

/** Freeze recipients and messages in the same transaction as the terminal incident. */
export function notifyTerminal(
  store: Store,
  id: string,
  now = Date.now(),
): boolean {
  const agent = store.agent(id);
  const incident = store.incident(id);
  const failure = store.failure(id);
  if (
    !incident ||
    !failure ||
    // A direct delivery is still in flight; retryablePending alone is empty.
    (incident.category === "transient" &&
      store.acceptedDirect(id) &&
      !store.uncertainDelivery(id)) ||
    incident.notified_at !== null ||
    store.one<{ deleted_at: number | null }>(
      "SELECT deleted_at FROM agents WHERE id=?",
      id,
    )?.deleted_at
  )
    return false;
  const decision = retryDecision(
    incident,
    now,
    store.retryablePending(id),
    !!store.uncertainDelivery(id),
  );
  if (decision.state !== "needs_action" && decision.state !== "exhausted")
    return false;
  const baseline = store.one<{ at: number }>(
    "SELECT at FROM incident_migration WHERE name='notification-baseline'",
  )!.at;
  const waiting = store.all<Waiting>(
    `SELECT m.sender,m.chat_id,c.kind,m.id AS message_id FROM deliveries d
      JOIN messages m ON m.id=d.through_message JOIN chats c ON c.id=m.chat_id
      JOIN agents a ON a.id=d.agent_id
      WHERE d.agent_id=? AND d.kind='direct' AND d.state IN ('pending','accepted')
        AND (a.last_success_at IS NULL OR d.created_at>a.last_success_at)
        AND (d.state='pending' OR d.created_at>=?)
      ORDER BY m.id DESC`,
    id,
    baseline,
  );
  const recipients = new Map<string, Recipient>();
  for (const item of waiting) {
    if (recipients.has(item.sender)) {
      const previous = recipients.get(item.sender)!;
      if (
        item.sender === LOCAL_USER &&
        !previous.last_chat &&
        item.kind === "group"
      )
        previous.last_chat = item.chat_id;
      continue;
    }
    if (
      item.sender !== LOCAL_USER &&
      !store.one(
        "SELECT 1 FROM agents WHERE id=? AND deleted_at IS NULL",
        item.sender,
      )
    )
      continue;
    recipients.set(item.sender, {
      recipient: item.sender,
      chat_id: item.chat_id,
      last_chat: item.kind === "group" ? item.chat_id : null,
    });
  }
  const manager =
    store.one<{ reports_to: string | null }>(
      "SELECT reports_to FROM agents WHERE id=?",
      id,
    )?.reports_to ?? LOCAL_USER;
  if (
    manager === LOCAL_USER ||
    store.one("SELECT 1 FROM agents WHERE id=? AND deleted_at IS NULL", manager)
  )
    recipients.set(
      manager,
      recipients.get(manager) ?? {
        recipient: manager,
        chat_id: null,
        last_chat: null,
      },
    );
  else
    recipients.set(
      LOCAL_USER,
      recipients.get(LOCAL_USER) ?? {
        recipient: LOCAL_USER,
        chat_id: null,
        last_chat: null,
      },
    );
  // A user who only sent private messages is notified there only when they are the manager.
  if (manager !== LOCAL_USER && !recipients.get(LOCAL_USER)?.last_chat)
    recipients.delete(LOCAL_USER);
  const count = waiting.length;
  const short = headline(failure.text);
  const ref = agent.ref;
  const reason =
    decision.state === "exhausted"
      ? `${short}，已自动重试 ${incident.attempts_used} 次`
      : `需要处理（${short}）`;
  store.transaction(() => {
    if (store.incident(id)?.notified_at !== null) return;
    for (const item of recipients.values()) {
      const user = item.recipient === LOCAL_USER;
      const text = user
        ? `${agent.name}运行出错：${reason}。${incident.category === "needsHuman" || incident.blocked ? instruction(failure.text, ref) : ""}`
        : item.chat_id
          ? `${agent.name}运行出错（${reason}），你在 ${store.chatRef(item.chat_id)} 的消息还没送到。`
          : `${agent.name}运行出错（${reason}），它手上还有 ${count} 条消息没处理。`;
      const chat = user
        ? (item.last_chat ?? store.createChat(agent.name, [id], id).id)
        : item.chat_id;
      store.run(
        "INSERT INTO incident_notices(incident_id,recipient,chat_id) VALUES(?,?,?)",
        incident.id,
        item.recipient,
        chat,
      );
      if (user) store.systemMessage(chat!, id, text, now);
      else
        store.addNotice(
          item.recipient,
          "system",
          `${agent.name}运行出错`,
          text,
          chat,
        );
    }
    store.run(
      "UPDATE failure_incidents SET notified_at=? WHERE id=? AND notified_at IS NULL",
      now,
      incident.id,
    );
  });
  return true;
}

/** Only a verified successful run_end calls this, inside finishTurn's transaction. */
export function notifyRecovered(store: Store, id: string, now = Date.now()) {
  const incident = store.incident(id);
  if (!incident || incident.notified_at === null) return;
  const agent = store.agent(id);
  if (
    store.one<{ deleted_at: number | null }>(
      "SELECT deleted_at FROM agents WHERE id=?",
      id,
    )?.deleted_at
  )
    return;
  const remaining = store.one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM deliveries WHERE agent_id=? AND kind='direct' AND state IN ('pending','accepted')",
    id,
  )!.n;
  const recipients = store.all<{
    recipient: string;
    chat_id: string | null;
    recovered_at: number | null;
  }>(
    "SELECT recipient,chat_id,recovered_at FROM incident_notices WHERE incident_id=?",
    incident.id,
  );
  for (const item of recipients) {
    if (item.recovered_at !== null) continue;
    if (
      item.recipient !== LOCAL_USER &&
      !store.one(
        "SELECT 1 FROM agents WHERE id=? AND deleted_at IS NULL",
        item.recipient,
      )
    )
      continue;
    const text =
      item.recipient === LOCAL_USER
        ? `${agent.name}已恢复。`
        : remaining
          ? `${agent.name}已恢复，还有 ${remaining} 条消息没处理完。`
          : `${agent.name}已恢复，积压的消息已送达。`;
    if (item.recipient === LOCAL_USER && item.chat_id)
      store.systemMessage(item.chat_id, id, text, now);
    else if (item.recipient !== LOCAL_USER)
      store.addNotice(
        item.recipient,
        "system",
        `${agent.name}已恢复`,
        text,
        item.chat_id,
      );
    store.run(
      "UPDATE incident_notices SET recovered_at=? WHERE incident_id=? AND recipient=?",
      now,
      incident.id,
      item.recipient,
    );
  }
}
