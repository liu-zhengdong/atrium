import type {
  AcpUpdate,
  PermissionOption,
  PermissionOutcome,
  StopReason,
} from "./client.ts";

/**
 * ACP 执行者的日志（#418）：桥把 ACP 的会话更新翻成 claude stream-json 同样的事件写进执行日志，
 * 摘要、最近动作、看门狗、捎话回显、接管后退出的判定都按 claude 的规则读，不另写一套。纯函数与纯状态，不做 IO。
 *
 * - 会话建立：`{type:"system",subtype:"init",session_id}`（续上会话时从这里取会话 id）
 * - 助手文字 / 思考：攒成段，遇到工具调用或本轮结束时写成 `{type:"assistant",message:{content:[{type:"text"|"thinking"}]}}`
 * - 工具调用：`tool_use` 块，名字按 ACP 的 kind 换成 claude 的叫法（execute → bash 等），入参取 rawInput
 * - 工具结束：`{type:"user",message:{content:[{type:"tool_result"}]}}`
 * - 捎话送达：`{type:"user",isReplay:true,uuid}`（live-input.ts 据此确认）
 * - 本轮结束：`{type:"result",is_error,stop_reason,result}`
 */

export type StreamEvent = Record<string, unknown>;

/** 攒着的文字超过这么多字先写一段，免得长回复一直不落日志、被看门狗当成没进展。 */
const FLUSH_CHARS = 4000;
/** 工具结果只留开头，日志不是工具输出的备份。 */
const RESULT_CHARS = 2000;

/** ACP 工具种类 → claude 的工具名（action.ts 按名字给出人话）。 */
const KIND_NAMES: Record<string, string> = {
  execute: "bash",
  read: "read",
  edit: "edit",
  delete: "delete",
  search: "grep",
  fetch: "webfetch",
};

const object = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export const initEvent = (
  sessionId: string,
  tool: string,
  model?: string,
): StreamEvent => ({
  type: "system",
  subtype: "init",
  session_id: sessionId,
  tool,
  ...(model ? { model } : {}),
  protocol: "acp",
});

/** 一条捎话已作为新一轮送进会话。 */
export const echoEvent = (uuid: string, text: string): StreamEvent => ({
  type: "user",
  isReplay: true,
  uuid,
  message: { role: "user", content: text },
});

/** 桥自己的说明（权限批准、选模型等），不算助手说的话。 */
export const noteEvent = (subtype: string, detail: object): StreamEvent => ({
  type: "system",
  subtype,
  ...detail,
});

const assistant = (block: StreamEvent): StreamEvent => ({
  type: "assistant",
  message: { role: "assistant", content: [block] },
});

/** 本轮结束：end_turn 为正常，其余（拒绝、长度、轮数用尽、取消、出错）为出错。 */
export function resultEvent(input: {
  sessionId: string;
  stopReason?: StopReason;
  text: string;
  error?: string;
}): StreamEvent {
  const ok = !input.error && input.stopReason === "end_turn";
  const reason = input.error
    ? input.error
    : ok
      ? ""
      : `本轮以 ${input.stopReason ?? "未知原因"} 结束`;
  return {
    type: "result",
    subtype: ok
      ? "success"
      : input.stopReason === "max_turn_requests"
        ? "error_max_turns"
        : "error_during_execution",
    is_error: !ok,
    stop_reason: input.stopReason ?? null,
    session_id: input.sessionId,
    result: ok
      ? input.text
      : [reason, input.text].filter((part) => part.trim()).join("\n"),
  };
}

const contentText = (value: unknown) => {
  const content = object(value);
  return content?.type === "text" && typeof content.text === "string"
    ? content.text
    : "";
};

/** 工具调用的入参：rawInput，缺路径时补上 locations 的第一个；标题放在 description。 */
function toolInput(update: AcpUpdate) {
  const input: Record<string, unknown> = { ...object(update.rawInput) };
  const location = Array.isArray(update.locations)
    ? object(update.locations[0])
    : undefined;
  if (
    typeof location?.path === "string" &&
    input.path === undefined &&
    input.file_path === undefined &&
    input.filePath === undefined
  )
    input.path = location.path;
  if (typeof update.title === "string" && input.description === undefined)
    input.description = update.title;
  return input;
}

function toolName(update: AcpUpdate) {
  const kind = typeof update.kind === "string" ? update.kind : "";
  if (KIND_NAMES[kind]) return KIND_NAMES[kind];
  return typeof update.title === "string" && update.title.trim()
    ? update.title.trim()
    : kind || "tool";
}

/** 工具结果的文字：content 里的文本块拼起来，截到上限。 */
function toolResultText(update: AcpUpdate) {
  const parts = Array.isArray(update.content) ? update.content : [];
  const text = parts
    .map((part) => contentText(object(part)?.content) || contentText(part))
    .filter(Boolean)
    .join("\n");
  return text.length > RESULT_CHARS ? `${text.slice(0, RESULT_CHARS)}…` : text;
}

/**
 * 一个会话的日志翻译：喂进 ACP 更新，吐出要写的事件。文字与思考按段攒着，
 * 遇到工具调用、本轮结束或攒得太长时写出。lastText 是本轮最后一次工具调用之后说的话，作本轮结果。
 */
export class StreamTranslator {
  private text = "";
  private thought = "";
  private said = "";
  private readonly started = new Set<string>();

  /** 本轮最后一段话（最后一次工具调用之后）；没有就是本轮说过的全部。 */
  get lastText() {
    return (this.said + this.text).trim();
  }

  /** 新一轮开始：清掉上一轮的「最后一段话」。 */
  turn() {
    this.said = "";
  }

  update(update: AcpUpdate): StreamEvent[] {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        this.text += contentText(update.content);
        return this.text.length >= FLUSH_CHARS ? this.flushText() : [];
      }
      case "agent_thought_chunk": {
        this.thought += contentText(update.content);
        return this.thought.length >= FLUSH_CHARS ? this.flushThought() : [];
      }
      case "tool_call": {
        const id = String(update.toolCallId ?? "");
        const events = this.flush();
        this.said = "";
        if (!this.started.has(id)) {
          this.started.add(id);
          events.push(
            assistant({
              type: "tool_use",
              id,
              name: toolName(update),
              input: toolInput(update),
            }),
          );
        }
        return [...events, ...this.finished(update)];
      }
      case "tool_call_update":
        return this.finished(update);
      default:
        return [];
    }
  }

  /** 写出攒着的思考与文字。 */
  flush(): StreamEvent[] {
    return [...this.flushThought(), ...this.flushText()];
  }

  private finished(update: AcpUpdate): StreamEvent[] {
    if (update.status !== "completed" && update.status !== "failed") return [];
    const id = String(update.toolCallId ?? "");
    this.started.delete(id);
    return [
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: id,
              is_error: update.status === "failed",
              content: toolResultText(update),
            },
          ],
        },
      },
    ];
  }

  private flushText(): StreamEvent[] {
    if (!this.text) return [];
    const text = this.text;
    this.said += text;
    this.text = "";
    return text.trim() ? [assistant({ type: "text", text })] : [];
  }

  private flushThought(): StreamEvent[] {
    if (!this.thought) return [];
    const thinking = this.thought;
    this.thought = "";
    return thinking.trim() ? [assistant({ type: "thinking", thinking })] : [];
  }
}

/**
 * 权限请求按档案自动答复（纯函数）：allow 选允许一次（没有就选一直允许），reject 选拒绝一次（没有就选一直拒绝）；
 * 选项里没有对应的就取消这次请求。只选「一次」，免得替用户在工具里留下长期授权。
 */
export function pickPermission(
  options: readonly PermissionOption[],
  policy: "allow" | "reject",
): PermissionOutcome {
  const order =
    policy === "allow"
      ? (["allow_once", "allow_always"] as const)
      : (["reject_once", "reject_always"] as const);
  for (const kind of order) {
    const option = options.find((item) => item.kind === kind);
    if (option) return { outcome: "selected", optionId: option.optionId };
  }
  return { outcome: "cancelled" };
}
