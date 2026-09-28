import { stat } from "node:fs/promises";
import { LOG_CHUNK, readLogChunk, readLogTail } from "./log-view.ts";
import {
  quietStep,
  scanOutput,
  stuckAt,
  type QuietLimits,
  type QuietState,
} from "./check-quiet.ts";

/** 检查进行中多久看一次日志。 */
export const QUIET_POLL_MS = 15_000;

/** 提醒与恢复：提醒带没输出多久、卡在哪；恢复表示这段安静之后又有输出了。 */
export type QuietEvent =
  { kind: "quiet"; quietMs: number; at: string | null } | { kind: "resumed" };

/**
 * 盯一份检查日志有没有新输出（t260）：定时读新增部分，判定交给 check-quiet.ts。
 * 提醒与恢复经 onEvent 报出；到结束线调 onStall（只报一次，之后停止）。读不到日志按没输出算。
 */
export class QuietWatch {
  private offset = 0;
  private carry = "";
  private state: QuietState;
  private timer?: NodeJS.Timeout;
  private polling = false;
  private stopped = false;

  constructor(
    private readonly options: {
      file: string;
      limits: QuietLimits;
      pollMs?: number;
      now?: () => number;
      onEvent?: (event: QuietEvent) => void;
      onStall?: (at: string | null) => void;
    },
  ) {
    this.state = { lastOutputAt: this.now(), warned: false };
  }

  private now() {
    return (this.options.now ?? Date.now)();
  }

  /** 从日志现有末尾开始盯（之前写的抬头、取提交的输出不算这次的输出）。 */
  async start() {
    this.offset = await stat(this.options.file)
      .then((info) => info.size)
      .catch(() => 0);
    this.state = { lastOutputAt: this.now(), warned: false };
    if (this.stopped) return;
    this.timer = setInterval(
      () => void this.poll(),
      this.options.pollMs ?? QUIET_POLL_MS,
    );
    this.timer.unref();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
  }

  async poll() {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const output = await this.read();
      if (this.stopped) return;
      if (output) {
        this.state.lastOutputAt = this.now();
        if (this.state.warned) {
          this.state.warned = false;
          this.emit({ kind: "resumed" });
        }
      }
      const step = quietStep(this.state, this.options.limits, this.now());
      if (step === "ok") return;
      const at = stuckAt((await readLogTail(this.options.file)).text);
      if (this.stopped) return;
      if (step === "warn") {
        this.state.warned = true;
        this.emit({
          kind: "quiet",
          quietMs: this.now() - this.state.lastOutputAt,
          at,
        });
        return;
      }
      this.stop();
      this.options.onStall?.(at);
    } catch {
      // 读日志出错按这一轮没输出算，下一轮再看。
    } finally {
      this.polling = false;
    }
  }

  private emit(event: QuietEvent) {
    try {
      this.options.onEvent?.(event);
    } catch {
      // 提醒记不上不影响检查。
    }
  }

  /** 读新增部分，返回有没有真输出；一次长出很多（超过一块）必定是真输出，只读最后一块接着看。 */
  private async read(): Promise<boolean> {
    const size = await stat(this.options.file)
      .then((info) => info.size)
      .catch(() => 0);
    // 日志被重写（重跑时截断）：从头看。
    if (size < this.offset) {
      this.offset = 0;
      this.carry = "";
    }
    let output = false;
    if (size - this.offset > LOG_CHUNK) {
      output = true;
      this.offset = size - LOG_CHUNK;
      this.carry = "";
    }
    while (this.offset < size) {
      const chunk = await readLogChunk(this.options.file, this.offset);
      if (chunk.next <= this.offset) break;
      this.offset = chunk.next;
      const scanned = scanOutput(this.carry, chunk.text);
      this.carry = scanned.carry;
      output ||= scanned.output;
    }
    return output;
  }
}
