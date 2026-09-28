import { open } from "node:fs/promises";
import type { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { InputDialect } from "../adapters/index.ts";

/**
 * 即时捎话的标准输入（#307）：claude / agy 以 --input-format stream-json 运行时服务握着执行者标准输入的写端。
 * 先写提示词，运行中把捎话作为新的用户消息写入；从日志里认两件事：
 * - result 事件：最后一条已写入的消息已回显且本轮结束时关掉标准输入；
 * - 回显：claude 带 isReplay 的用户消息（--replay-user-messages）按 uuid 确认这条捎话已被读入；
 *   agy 不回显消息正文，每读入一条就打一个 user_input 步骤，按写入顺序确认（第一条是提示词本身）。
 * 服务退出时写端随之关闭，执行者同样在本轮结束后退出；重启后接管的进程没有写端，捎话改为续上会话。
 */

/** stream-json 输入的一条用户消息：claude 用 type，agy 用 event（agy 1.2.12 实测，缺 event 直接报错）。 */
export const userLine = (
  text: string,
  uuid?: string,
  dialect: InputDialect = "claude",
) =>
  dialect === "agy"
    ? `${JSON.stringify({ event: "user", message: { role: "user", content: text } })}\n`
    : `${JSON.stringify({
        type: "user",
        ...(uuid ? { uuid } : {}),
        session_id: "",
        parent_tool_use_id: null,
        message: { role: "user", content: text },
      })}\n`;

/** 单行上限：超过还没换行的半截丢掉，免得异常输出把内存撑大。 */
const LINE_MAX = 16 * 1024 * 1024;
const CHUNK = 256 * 1024;

/** echo 带 uuid 的是 claude 的回显；input 是 agy 读入了一条消息（不知道是哪条，按写入顺序对）。 */
export type LineSignal =
  { kind: "result" } | { kind: "echo"; uuid: string } | { kind: "input" };

/** agy：`{"event":"result",…}` 本轮结束；`step_type:"user_input"` 且 DONE 的步骤是读入了一条消息。 */
function agySignal(line: string): LineSignal | undefined {
  if (
    !line.startsWith("{") ||
    (!line.includes('"event":"result"') && !line.includes('"user_input"'))
  )
    return undefined;
  try {
    const event = JSON.parse(line) as {
      event?: unknown;
      step_update?: { step_type?: unknown; state?: unknown };
    };
    if (event.event === "result") return { kind: "result" };
    return event.event === "step_update" &&
      event.step_update?.step_type === "user_input" &&
      event.step_update.state === "DONE"
      ? { kind: "input" }
      : undefined;
  } catch {
    return undefined;
  }
}

/** 日志里的一行是不是本轮结束或捎话回显；先筛候选，再核对顶层 type（agy 为 event）。 */
export function lineSignal(
  line: string,
  dialect: InputDialect = "claude",
): LineSignal | undefined {
  if (dialect === "agy") return agySignal(line);
  if (
    !line.startsWith("{") ||
    (!line.includes('"type":"result"') && !line.includes('"isReplay":true'))
  )
    return undefined;
  try {
    const event = JSON.parse(line) as {
      type?: unknown;
      uuid?: unknown;
      isReplay?: unknown;
    };
    if (event.type === "result") return { kind: "result" };
    return event.type === "user" &&
      event.isReplay === true &&
      typeof event.uuid === "string"
      ? { kind: "echo", uuid: event.uuid }
      : undefined;
  } catch {
    return undefined;
  }
}

export class LiveInput {
  private buffer = "";
  private readonly decoder = new StringDecoder("utf8");
  private ended = false;
  /** 已写入、还没确认读入的捎话；Set 保持写入顺序，agy 按顺序确认。 */
  private readonly awaitingEcho = new Set<string>();
  /** agy 已读入的消息条数：第一条是拉起时写入的提示词，不是捎话。 */
  private inputs = 0;
  private scanning?: Promise<void>;
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly stdin: Writable,
    private readonly logFile: string,
    private offset: number,
    private readonly onEcho: (uuid: string) => void,
    pollMs = 500,
    private readonly dialect: InputDialect = "claude",
  ) {
    // 执行者先退出时写入会 EPIPE；捎话已登记，退出后按续上处理，这里静默。
    stdin.on("error", () => {
      this.ended = true;
    });
    this.timer = setInterval(() => void this.scan(), pollMs);
    this.timer.unref();
  }

  /** 还能即时写入：本轮没结束、写端没断。 */
  get open() {
    return !this.ended && this.stdin.writable;
  }

  send(text: string, uuid: string) {
    if (!this.open) return false;
    this.awaitingEcho.add(uuid);
    this.stdin.write(userLine(text, uuid, this.dialect));
    return true;
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    this.stdin.end();
  }

  /** 进程退出后：读完剩下的日志（确认最后的回显），停止轮询并关掉写端。 */
  async finish() {
    clearInterval(this.timer);
    await this.scan();
    this.end();
  }

  scan() {
    this.scanning ??= this.read().finally(() => {
      this.scanning = undefined;
    });
    return this.scanning;
  }

  private async read() {
    let file;
    try {
      file = await open(this.logFile, "r");
    } catch {
      return;
    }
    try {
      const chunk = Buffer.alloc(CHUNK);
      for (;;) {
        const { bytesRead } = await file.read(chunk, 0, CHUNK, this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        this.feed(this.decoder.write(chunk.subarray(0, bytesRead)));
      }
    } finally {
      await file.close();
    }
  }

  private feed(text: string) {
    this.buffer += text;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      const signal = lineSignal(line, this.dialect);
      if (signal?.kind === "result" && !this.awaitingEcho.size) this.end();
      else if (signal?.kind === "echo") this.echoed(signal.uuid);
      else if (signal?.kind === "input" && ++this.inputs > 1) {
        const oldest = this.awaitingEcho.values().next();
        if (!oldest.done) this.echoed(oldest.value);
      }
    }
    if (this.buffer.length > LINE_MAX) this.buffer = "";
  }

  private echoed(uuid: string) {
    this.awaitingEcho.delete(uuid);
    this.onEcho(uuid);
  }
}
