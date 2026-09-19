import type { Store } from "./store.ts";
import { Problem } from "./store.ts";
import {
  runtimeEvents,
  type RuntimeEventPage,
  type TraceItem,
  type TraceDetail,
} from "../shared/trace.ts";

const columns =
  "id,session_id,generation,at,ended_at,kind,name,title,state,truncated";
function toolTitle(name: string, text = "") {
  let detail = "";
  try {
    const args = JSON.parse(text);
    detail =
      args.path ??
      args.file_path ??
      args.command ??
      args.tool ??
      args.search ??
      args.describe ??
      args.connect ??
      args.server ??
      "";
  } catch {
    /* Truncated/opaque input is still available in details. */
  }
  const labels: Record<string, string> = {
    read: "读取",
    edit: "修改",
    write: "写入",
    bash: "执行命令",
    mcp: "调用 MCP",
    mcpScript: "执行 MCP 脚本",
  };
  return `${labels[name] ?? name}${typeof detail === "string" && detail ? ` · ${detail}` : ""}`
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

/** Materialized actions: two writes per tool, never per token. Details are fetched separately. */
export class TraceStore {
  constructor(private store: Store) {
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
        const name = e.name ?? "",
          text = e.text ?? "";
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
        "INSERT INTO trace_cursors VALUES(?,?,?,?) ON CONFLICT(agent_id,runtime_id,generation) DO UPDATE SET seq=excluded.seq",
        agent,
        runtime,
        generation,
        page.nextAfter,
      );
    });
    return true;
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
        .map((row) => ({ ...row, truncated: !!row.truncated })),
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
    return { ...row, truncated: !!row.truncated };
  }
}
