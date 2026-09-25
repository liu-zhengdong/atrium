import { randomUUID } from "node:crypto";

// Never infer that a tool is read-only merely from its name. read_chat and
// view_message_box advance receipts even though they return data.
const safeReads = new Set([
  "list_agents",
  "user_info",
  "list_fork_sources",
  "list_chats",
  "search_messages",
  "get_config",
]);
const checkBeforeRetry: Record<string, string> = {
  fork_agent: "list_agents 查一下身份是否已经建立",
  open_direct: "list_chats 查一下私聊是否已经建立",
  create_group: "list_chats 查一下群和成员是否已经建立",
  invite_agent: "list_chats 查一下目标群的成员",
  read_chat: "read_chat 指定已知的旧 after，或用 search_messages 找回那段消息",
  view_message_box:
    "view_message_box 指定已知的 after 并设置 pending_only:false 核对条目",
  claim_status: "list_agents 查一下自己的工作声明",
  set_description: "list_agents 查一下自己的介绍",
  complete_inbox: "view_message_box 查一下哪些条目仍待完成",
  update_config: "get_config 查一下运行偏好",
  set_reports_to: "get_config 查一下自己的汇报对象",
};
export const mcpToolNames = [
  ...safeReads,
  "send_message",
  ...Object.keys(checkBeforeRetry),
];

export type PreparedCall = {
  name: string;
  args: Record<string, unknown>;
  clientId: string | null;
  retryAfterSend: boolean;
};

/** Prepare once per MCP call, not once per WebSocket connection or attempt. */
export function prepareMcpCall(
  name: string,
  args: Record<string, unknown>,
  createId: () => string = randomUUID,
): PreparedCall {
  if (name === "send_message") {
    const clientId =
      typeof args.client_id === "string" && args.client_id
        ? args.client_id
        : createId();
    return {
      name,
      args: { ...args, client_id: clientId },
      clientId,
      retryAfterSend: true,
    };
  }
  return {
    name,
    args,
    clientId: null,
    retryAfterSend: safeReads.has(name),
  };
}

/** Return explicit, actionable errors without exposing socket or provider details. */
export function mcpConnectionProblem(call: PreparedCall, sent: boolean) {
  if (!sent)
    return {
      code: "atrium_offline" as const,
      message:
        call.name === "send_message"
          ? "Atrium 离线，消息未发送。稍后重发即可。"
          : "Atrium 离线，这次操作未执行。稍后重试即可。",
      ...(call.clientId ? { client_id: call.clientId } : {}),
    };
  if (call.clientId)
    return {
      code: "atrium_outcome_unknown" as const,
      message: `Atrium 连接中断，这条消息可能已经发出。稍后重发时带上 client_id=${call.clientId}，不会重复。`,
      client_id: call.clientId,
    };
  return {
    code: "atrium_outcome_unknown" as const,
    message: checkBeforeRetry[call.name]
      ? `Atrium 连接中断，这次操作可能已经执行。重试前先用 ${checkBeforeRetry[call.name]}。`
      : safeReads.has(call.name)
        ? "Atrium 连接中断，请稍后重新查询。"
        : "Atrium 连接中断，这次操作可能已经执行。重试前先查一下结果。",
  };
}
