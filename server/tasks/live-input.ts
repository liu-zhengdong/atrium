import { open } from "node:fs/promises";
import type { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/**
 * 即时捎话的标准输入（#307）：claude --input-format stream-json 时服务握着执行者标准输入的写端。
 * 先写提示词，运行中把捎话作为新的用户消息写入；从日志里认两件事：
 * - result 事件：这一轮结束了，关掉标准输入，执行者处理完已读入的消息就退出（与读提示词文件时一样）；
 * - 带 isReplay 的用户消息（--replay-user-messages 回显）：按 uuid 确认这条捎话已被读入。
 * 服务退出时写端随之关闭，执行者同样在本轮结束后退出；重启后接管的进程没有写端，捎话改为续上会话。
 */

/** stream-json 输入的一条用户消息。 */
export const userLine = (text: string, uuid?: string) =>
  `${JSON.stringify({
    type: "user",
    ...(uuid ? { uuid } : {}),
    session_id: "",
    parent_tool_use_id: null,
    message: { role: "user", content: text },
  })}\n`;

/** 单行上限：超过还没换行的半截丢掉，免得异常输出把内存撑大。 */
const LINE_MAX = 16 * 1024 * 1024;
const CHUNK = 256 * 1024;

export type LineSignal = { kind: "result" } | { kind: "echo"; uuid: string };

/** 日志里的一行是不是本轮结束或捎话回显；只解析这两类行首，不扫描正文。 */
export function lineSignal(line: string): LineSignal | undefined {
  if (line.startsWith('{"type":"result"')) return { kind: "result" };
  if (!line.startsWith('{"type":"user"') || !line.includes('"isReplay":true'))
    return undefined;
  try {
    const event = JSON.parse(line) as { uuid?: unknown; isReplay?: unknown };
    return event.isReplay === true && typeof event.uuid === "string"
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
  private scanning?: Promise<void>;
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly stdin: Writable,
    private readonly logFile: string,
    private offset: number,
    private readonly onEcho: (uuid: string) => void,
    pollMs = 500,
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
    this.stdin.write(userLine(text, uuid));
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
      const signal = lineSignal(line);
      if (signal?.kind === "result") this.end();
      else if (signal?.kind === "echo") this.onEcho(signal.uuid);
    }
    if (this.buffer.length > LINE_MAX) this.buffer = "";
  }
}
