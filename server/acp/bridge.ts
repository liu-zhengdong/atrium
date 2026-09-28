import type {
  AcpConnection,
  AcpUpdate,
  PermissionOutcome,
  PermissionRequest,
  StopReason,
} from "./client.ts";
import { sessionConfig } from "./session-config.ts";
import {
  echoEvent,
  initEvent,
  noteEvent,
  pickPermission,
  resultEvent,
  StreamTranslator,
  type StreamEvent,
} from "./stream.ts";

/**
 * ACP 执行者的桥（#418）：运行时把它当成一个普通执行者进程拉起（独立进程组、输出直写日志、服务重启不带走），
 * 它再经 ACP 驱动真正的工具：
 * 建会话（或按会话 id 续上）→ 按需选模型与思考强度 → 标准输入读到的第一条消息作提示词开一轮 →
 * 运行中读到的捎话排到本轮之后作为追加消息再开一轮（送进去时回显，运行时据此确认送达）→
 * 本轮结束且没有排队的消息时写 result → 标准输入关闭后退出。权限请求按档案自动批准或拒绝。
 * 日志格式见 stream.ts。退出码：最后一轮 end_turn 为 0，其余为 1。
 */

export type InputMessage = { text: string; uuid?: string };

/** 标准输入的一行（claude stream-json 的用户消息，live-input.ts userLine 写的）→ 消息；不是用户消息返回 undefined。 */
export function inputMessage(line: string): InputMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  const event = value as {
    type?: unknown;
    uuid?: unknown;
    message?: { content?: unknown };
  };
  if (event?.type !== "user") return undefined;
  const content = event.message?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part: { type?: unknown; text?: unknown }) =>
              part?.type === "text" && typeof part.text === "string"
                ? part.text
                : "",
            )
            .join("")
        : "";
  if (!text.trim()) return undefined;
  return typeof event.uuid === "string" && event.uuid
    ? { text, uuid: event.uuid }
    : { text };
}

export type BridgeOptions = {
  tool: string;
  cwd: string;
  permissions: "allow" | "reject";
  /** 经 ACP 会话配置设的模型与思考强度（档案写了 *_args 的已在工具命令行里）。 */
  model?: string;
  effort?: string;
  /** 续上的会话 id：工具须声明 loadSession。 */
  resume?: string;
  write(event: StreamEvent): void;
};

type Connection = Pick<AcpConnection, "request">;

const INITIALIZE = {
  protocolVersion: 1,
  clientCapabilities: {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  },
  clientInfo: { name: "atrium", version: "1" },
};

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export class AcpBridge {
  private sessionId = "";
  private replaying = false;
  private readonly queue: InputMessage[] = [];
  private ended = false;
  private wake?: () => void;
  private readonly log = new StreamTranslator();

  constructor(private readonly options: BridgeOptions) {}

  /** 连接层回调（AcpConnection 的 handlers）。 */
  readonly handlers = {
    update: (sessionId: string, update: AcpUpdate) => {
      if (this.replaying || (this.sessionId && sessionId !== this.sessionId))
        return;
      for (const event of this.log.update(update)) this.options.write(event);
    },
    permission: async (
      request: PermissionRequest,
    ): Promise<PermissionOutcome> => {
      const outcome = pickPermission(
        request.options ?? [],
        this.options.permissions,
      );
      this.options.write(
        noteEvent("permission", {
          title: request.toolCall?.title ?? "",
          policy: this.options.permissions,
          outcome:
            outcome.outcome === "selected" ? outcome.optionId : "cancelled",
        }),
      );
      return outcome;
    },
    exit: (reason: string) => {
      this.options.write(noteEvent("agent_exit", { reason }));
      this.poke();
    },
  };

  /** 标准输入读到一条消息。 */
  push(input: InputMessage) {
    this.queue.push(input);
    this.poke();
  }

  /** 标准输入关闭：排队的送完、本轮结束后退出。 */
  end() {
    this.ended = true;
    this.poke();
  }

  /** 跑完整个会话，返回退出码。 */
  async run(connection: Connection): Promise<number> {
    try {
      await this.start(connection);
    } catch (error) {
      this.options.write(
        resultEvent({
          sessionId: this.sessionId,
          text: "",
          error: `ACP 会话没建起来：${message(error)}`,
        }),
      );
      return 1;
    }
    let code: number | undefined;
    for (;;) {
      const next = await this.next();
      if (!next) break;
      this.log.turn();
      if (next.uuid) this.options.write(echoEvent(next.uuid, next.text));
      let stopReason: StopReason;
      try {
        const result = await connection.request<{ stopReason: StopReason }>(
          "session/prompt",
          {
            sessionId: this.sessionId,
            prompt: [{ type: "text", text: next.text }],
          },
        );
        stopReason = result?.stopReason;
      } catch (error) {
        this.flush();
        this.options.write(
          resultEvent({
            sessionId: this.sessionId,
            text: this.log.lastText,
            error: `ACP 请求出错：${message(error)}`,
          }),
        );
        return 1;
      }
      this.flush();
      code = stopReason === "end_turn" ? 0 : 1;
      // 还有排队的捎话就接着下一轮，全部送完才写 result（运行时见到 result 且没有待确认的捎话才关标准输入）。
      if (!this.queue.length)
        this.options.write(
          resultEvent({
            sessionId: this.sessionId,
            stopReason,
            text: this.log.lastText,
          }),
        );
    }
    if (code === undefined) {
      this.options.write(
        resultEvent({
          sessionId: this.sessionId,
          text: "",
          error: "标准输入关闭前没收到提示词",
        }),
      );
      return 1;
    }
    return code;
  }

  private async start(connection: Connection) {
    const init = await connection.request<{
      agentCapabilities?: { loadSession?: boolean };
    }>("initialize", INITIALIZE);
    const { cwd, resume } = this.options;
    let session: unknown;
    if (resume) {
      if (init?.agentCapabilities?.loadSession !== true)
        throw new Error("工具没有声明 loadSession，不能按会话续上");
      this.replaying = true;
      try {
        session = await connection.request("session/load", {
          sessionId: resume,
          cwd,
          mcpServers: [],
        });
      } finally {
        this.replaying = false;
      }
      this.sessionId = resume;
    } else {
      const created = await connection.request<{ sessionId?: unknown }>(
        "session/new",
        { cwd, mcpServers: [] },
      );
      if (typeof created?.sessionId !== "string" || !created.sessionId)
        throw new Error("session/new 没有给会话 id");
      session = created;
      this.sessionId = created.sessionId;
    }
    this.options.write(
      initEvent(this.sessionId, this.options.tool, this.options.model),
    );
    const plan = sessionConfig(this.sessionId, session, {
      model: this.options.model,
      effort: this.options.effort,
    });
    if (!plan.ok) throw new Error(plan.problem);
    for (const request of plan.requests) {
      await connection.request(request.method, request.params);
      this.options.write(noteEvent("config", request.params));
    }
  }

  private flush() {
    for (const event of this.log.flush()) this.options.write(event);
  }

  /** 下一条要送的消息；输入已关闭且没有排队的返回 undefined。 */
  private async next(): Promise<InputMessage | undefined> {
    for (;;) {
      const next = this.queue.shift();
      if (next) return next;
      if (this.ended) return undefined;
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }

  private poke() {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}
