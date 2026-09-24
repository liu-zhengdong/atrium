import type { Store } from "./store.ts";
import type { Message } from "../shared/schema.ts";
import { Problem } from "./store.ts";
import {
  runtimeEvents,
  type RuntimeEventPage,
  type TraceItem,
  type TraceDetail,
} from "../shared/trace.ts";

const columns =
  "id,session_id,generation,at,ended_at,kind,name,title,state,truncated,CASE WHEN input<>'' OR output<>'' THEN 1 ELSE 0 END AS has_detail";
const labels: Record<string, string> = {
  read: "读取",
  edit: "修改",
  write: "写入",
  bash: "执行命令",
  mcpScript: "执行 MCP 脚本",
};

/**
 * 固定 mcp 代理的几种动作。查一下、搜一下和真干了一件事得分开说；参数里可能
 * 同时带着 server，所以按这个顺序取第一个命中的，server 排最后。
 */
const mcpActions = [
  ["tool", "调用 MCP"],
  ["describe", "查看 MCP 工具"],
  ["search", "搜索 MCP 工具"],
  ["instructions", "读 MCP 说明"],
  ["connect", "连接 MCP"],
  ["action", "MCP 操作"],
  ["server", "列出 MCP 工具"],
] as const;

/** 铺垫语句不说明这一步在干什么，摘要跳过它们去找第一条真正做事的命令。 */
const prelude =
  /^(set|cd|export|source|\.|umask|shopt|alias|echo|printf)\b|^[A-Za-z_][A-Za-z0-9_]*=/;

/** 多行脚本取第一条真正做事的命令；全是铺垫时退回第一条。管道 | 不拆，它是一条命令。 */
export function commandSummary(command: string) {
  const statements = command
    .split(/\r?\n|;|&&/)
    .map((piece) => piece.trim())
    .filter(Boolean);
  return (
    statements.find((piece) => !prelude.test(piece)) ?? statements[0] ?? ""
  );
}

/** 标题是轨迹这一层的全部信息：一句话说清这一步在干什么，原文留在参数里。 */
export function toolTitle(name: string, text = "") {
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object")
      args = parsed as Record<string, unknown>;
  } catch {
    /* Truncated/opaque input is still available in details. */
  }
  const pick = (key: string) =>
    typeof args[key] === "string" ? (args[key] as string) : "";
  if (name === "mcp") {
    const action = mcpActions.find(([key]) => pick(key));
    return action ? line(action[1], pick(action[0])) : "查看 MCP 状态";
  }
  return line(
    labels[name] ?? name,
    name === "bash"
      ? commandSummary(pick("command"))
      : pick("path") || pick("file_path"),
  );
}

/** 摘要按一行可读截，截了就明说截了。 */
const TITLE_DETAIL = 80;
function line(verb: string, detail: string) {
  const flat = detail.replace(/\s+/g, " ").trim();
  const cut =
    flat.length > TITLE_DETAIL ? `${flat.slice(0, TITLE_DETAIL)}…` : flat;
  return `${verb}${cut ? ` · ${cut}` : ""}`;
}

/** 每个身份保留多少条轨迹。轨迹是给用户翻最近干了什么的，不是永久账本。 */
const TRACE_KEEP = 2000;

function deliveryLabel(item: { name: string; output: string }) {
  if (item.name === "Atrium 接入说明") return "Atrium 投递：接入说明";
  if (item.name === "Atrium")
    return item.output.startsWith("[Atrium 消息箱提醒]") ? "消息箱提醒" : null; // 普通聊天消息不是自主发言的系统触发。
  return item.name ? `外部事件：${item.name}` : null;
}

/** Materialized actions: two writes per tool, never per token. Details are fetched separately. */
export class TraceStore {
  constructor(
    private store: Store,
    private redact: (agent: string, text: string) => string = (_, text) => text,
  ) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS trace_cursors (
      agent_id TEXT NOT NULL REFERENCES agents(id), runtime_id TEXT NOT NULL, generation TEXT NOT NULL,
      seq INTEGER NOT NULL, PRIMARY KEY(agent_id,runtime_id,generation));
      CREATE TABLE IF NOT EXISTS trace_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL REFERENCES agents(id),
      runtime_id TEXT NOT NULL, generation TEXT NOT NULL, session_id TEXT NOT NULL, seq INTEGER NOT NULL,
      call_id TEXT, at INTEGER NOT NULL, ended_at INTEGER, kind TEXT NOT NULL, name TEXT NOT NULL,
      title TEXT NOT NULL, state TEXT NOT NULL, input TEXT NOT NULL, output TEXT NOT NULL,
      truncated INTEGER NOT NULL DEFAULT 0, UNIQUE(agent_id,runtime_id,generation,seq));
      CREATE INDEX IF NOT EXISTS trace_agent_page ON trace_actions(agent_id,id);
      CREATE UNIQUE INDEX IF NOT EXISTS trace_tool ON trace_actions(agent_id,runtime_id,generation,call_id) WHERE call_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS trace_running ON trace_actions(agent_id,runtime_id,generation) WHERE state='running';`);
  }
  cursor(agent: string, runtime: string, generation: string) {
    return (
      this.store.one<{ seq: number }>(
        "SELECT seq FROM trace_cursors WHERE agent_id=? AND runtime_id=? AND generation=?",
        agent,
        runtime,
        generation,
      )?.seq ?? 0
    );
  }
  ingest(agent: string, value: RuntimeEventPage) {
    this.store.agent(agent);
    const page = runtimeEvents.parse(value),
      previous = this.cursor(agent, page.runtimeId, page.generation);
    let last = previous;
    for (const event of page.items) {
      if (event.seq <= last || (!page.gap && event.seq !== last + 1))
        throw new Problem(400, "轨迹游标不连续");
      if (event.kind.startsWith("tool_") && (!event.callId || !event.name))
        throw new Problem(400, "工具轨迹缺少标识");
      last = event.seq;
    }
    if (page.nextAfter !== last || (page.gap && !page.items.length))
      throw new Problem(400, "轨迹游标与正文不一致");
    if (!page.items.length) return false;
    const { runtimeId: runtime, generation, sessionId: session } = page;
    this.store.transaction(() => {
      this.store.run(
        "UPDATE trace_actions SET state='unknown' WHERE agent_id=? AND state='running' AND (runtime_id<>? OR generation<>?)",
        agent,
        runtime,
        generation,
      );
      const insert = (
        seq: number,
        at: number,
        kind: string,
        name: string,
        title: string,
        state: string,
        input = "",
        output = "",
        call: string | null = null,
        truncated = false,
      ) =>
        this.store.run(
          "INSERT INTO trace_actions(agent_id,runtime_id,generation,session_id,seq,at,kind,name,title,state,input,output,call_id,truncated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          agent,
          runtime,
          generation,
          session,
          seq,
          at,
          kind,
          name,
          title,
          state,
          input,
          output,
          call,
          Number(truncated),
        );
      if (page.gap) {
        this.store.run(
          "UPDATE trace_actions SET state='unknown' WHERE agent_id=? AND state='running'",
          agent,
        );
        insert(
          page.items[0].seq - 1,
          page.items[0].at,
          "gap",
          "",
          "连接期间有轨迹缺失",
          "unknown",
          "",
          "运行端仅保留有界近期事件，缺失部分不作推断。",
        );
      }
      for (const e of page.items) {
        // name 来自 pi-atrium 的运行事件：工具名，或 message 事件的消息角色（"user" 即
        // Pi 侧的输入角色）。它不是 Atrium 的用户短号，不跟着 u1 走。
        const name = e.name ?? "",
          text = this.redact(agent, e.text ?? "");
        if (e.kind === "tool_end") {
          const updated = this.store.run(
            "UPDATE trace_actions SET ended_at=?,state=?,output=?,truncated=MAX(truncated,?) WHERE agent_id=? AND runtime_id=? AND generation=? AND call_id=?",
            e.at,
            e.error ? "error" : "complete",
            text,
            Number(!!e.truncated),
            agent,
            runtime,
            generation,
            e.callId!,
          );
          if (!updated.changes)
            insert(
              e.seq,
              e.at,
              "tool",
              name,
              toolTitle(name),
              e.error ? "error" : "complete",
              "未观测到开始事件",
              text,
              e.callId!,
              e.truncated,
            );
        } else if (e.kind === "tool_start") {
          insert(
            e.seq,
            e.at,
            "tool",
            name,
            toolTitle(name, text),
            "running",
            text,
            "",
            e.callId!,
            e.truncated,
          );
        } else {
          const title =
            e.kind === "session"
              ? "进入会话"
              : e.kind === "run_start"
                ? "开始处理"
                : e.kind === "run_end"
                  ? "本轮运行结束"
                  : e.kind === "delivery"
                    ? `收到 ${name} 的投递`
                    : name === "user"
                      ? "收到用户消息"
                      : e.error
                        ? "运行异常"
                        : "完成回复";
          if (e.kind === "run_end")
            this.store.run(
              "UPDATE trace_actions SET state='unknown' WHERE agent_id=? AND runtime_id=? AND generation=? AND state='running'",
              agent,
              runtime,
              generation,
            );
          insert(
            e.seq,
            e.at,
            e.kind,
            name,
            title,
            e.error ? "error" : "complete",
            "",
            text,
            null,
            e.truncated,
          );
        }
      }
      this.store.run(
        "INSERT INTO trace_cursors(agent_id,runtime_id,generation,seq) VALUES(?,?,?,?) ON CONFLICT(agent_id,runtime_id,generation) DO UPDATE SET seq=excluded.seq",
        agent,
        runtime,
        generation,
        page.nextAfter,
      );
      this.trim(agent);
    });
    return true;
  }
  /**
   * 只留这个身份最近 TRACE_KEEP 条。子查询走 trace_agent_page(agent_id,id) 取第
   * TRACE_KEEP+1 新的那条的 id，不够这么多时返回 NULL，比较不成立就一行不删。
   */
  private trim(agent: string) {
    this.store.run(
      `DELETE FROM trace_actions WHERE agent_id=?1 AND id <= (
         SELECT id FROM trace_actions WHERE agent_id=?1 ORDER BY id DESC LIMIT 1 OFFSET ?2)`,
      agent,
      TRACE_KEEP,
    );
  }
  /** Only a successful, captured send_message result can bind a chat row to a Pi run.
   * CLI --as, opaque scripts and older/trimmed traces intentionally remain unlabelled.
   */
  triggers(agent: string, chatId: string, messages: Message[]) {
    const chat = this.store.chat(chatId);
    if (
      chat.kind !== "direct" ||
      chat.direct_agent !== agent ||
      !messages.length
    )
      return {};
    const ids = messages.filter((m) => m.sender === agent).map((m) => m.id);
    if (!ids.length) return {};
    const eligible = new Set(
      this.store
        .all<{ id: number }>(
          `SELECT m.id FROM messages m WHERE m.chat_id=? AND m.sender=?
         AND m.id IN (${ids.map(() => "?").join(",")})
         AND NOT EXISTS (
           SELECT 1 FROM messages other WHERE other.chat_id=m.chat_id
           AND other.sender<>m.sender AND other.id<m.id AND other.id>COALESCE((
             SELECT MAX(previous.id) FROM messages previous
             WHERE previous.chat_id=m.chat_id AND previous.sender=m.sender AND previous.id<m.id
           ),0)
         )`,
          chatId,
          agent,
          ...ids,
        )
        .map((row) => row.id),
    );
    type Action = {
      id: number;
      runtime_id: string;
      generation: string;
      kind: string;
      name: string;
      title: string;
      output: string;
      input: string;
      at: number;
      ended_at: number | null;
      state: string;
      truncated: number;
    };
    const candidates = new Map(
      messages.map((message) => [message.id, message]),
    );
    const actions = this.store.all<Action>(
      `SELECT id,runtime_id,generation,kind,name,title,input,output,at,ended_at,state,truncated FROM trace_actions
       WHERE agent_id=? AND (kind IN ('delivery','run_start','run_end')
       OR (kind='tool' AND name='mcp'))
       ORDER BY id`,
      agent,
    );
    const result: Record<number, { label: string; trace_id: number }> = {};
    const runs = new Map<
      string,
      { active: boolean; delivery: Action | null }
    >();
    for (const action of actions) {
      const key = `${action.runtime_id}:${action.generation}`;
      const run = runs.get(key) ?? { active: false, delivery: null };
      runs.set(key, run);
      if (action.kind === "delivery") run.delivery = action;
      else if (action.kind === "run_start") run.active = true;
      else if (action.kind === "run_end") {
        run.active = false;
        run.delivery = null;
      } else if (
        run.active &&
        run.delivery &&
        action.state === "complete" &&
        !action.truncated &&
        action.output
      ) {
        let call: unknown;
        try {
          call = JSON.parse(action.input);
        } catch {
          continue;
        }
        if (
          !call ||
          typeof call !== "object" ||
          (call as Record<string, unknown>).server !== "atrium" ||
          !["send_message", "atrium_send_message"].includes(
            (call as Record<string, unknown>).tool as string,
          )
        )
          continue;
        // Proxy tool output is the JSON returned by Atrium send_message. Never
        // infer a message from its body or timestamp: another writer could send it.
        let value: unknown;
        try {
          value = JSON.parse(action.output);
        } catch {
          continue;
        }
        if (!value || typeof value !== "object") continue;
        const sent = value as Record<string, unknown>;
        const id = sent.id;
        const message = typeof id === "number" ? candidates.get(id) : undefined;
        if (
          typeof id !== "number" ||
          !eligible.has(id) ||
          !message ||
          message.created_at < action.at ||
          message.created_at > (action.ended_at ?? action.at) ||
          sent.chat_id !== chat.ref ||
          sent.sender !== this.store.agentRef(agent)
        )
          continue;
        const label = deliveryLabel(run.delivery);
        if (label) result[id] = { label, trace_id: run.delivery.id };
      }
    }
    return result;
  }
  page(agent: string, before = Number.MAX_SAFE_INTEGER) {
    this.store.agent(agent);
    const rows = this.store.all<TraceItem>(
      `SELECT ${columns} FROM trace_actions WHERE agent_id=? AND id<? ORDER BY id DESC LIMIT 51`,
      agent,
      before,
    );
    return {
      items: rows
        .slice(0, 50)
        .reverse()
        .map((row) => ({
          ...row,
          truncated: !!row.truncated,
          has_detail: !!row.has_detail,
        })),
      has_more: rows.length > 50,
    };
  }
  detail(agent: string, id: number): TraceDetail {
    this.store.agent(agent);
    const row = this.store.one<TraceDetail>(
      `SELECT ${columns},input,output FROM trace_actions WHERE agent_id=? AND id=?`,
      agent,
      id,
    );
    if (!row) throw new Problem(404, "轨迹不存在");
    return { ...row, truncated: !!row.truncated, has_detail: !!row.has_detail };
  }
}
