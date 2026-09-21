/** 一个 Agent 的未读会话摘要。 */
export type UnreadChat = {
  chat_id: string;
  name: string;
  count: number;
  fresh: number;
  latest: number;
};

/**
 * 未读摘要按 Agent 缓存，写入这个 Agent 可见的消息、已读位置或成员关系时失效。
 * 缓存自己管失效入口，调用方不碰内部 Map。
 */
export class UnreadCache {
  private byAgent = new Map<string, UnreadChat[]>();
  get(agentId: string) {
    return this.byAgent.get(agentId);
  }
  set(agentId: string, chats: UnreadChat[]) {
    this.byAgent.set(agentId, chats);
  }
  forget(agentId: string) {
    this.byAgent.delete(agentId);
  }
}
