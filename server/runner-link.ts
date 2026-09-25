import type WebSocket from "ws";

export type RunnerRequest = {
  id: number;
  method: string;
  params: unknown;
};
type RunnerReply = {
  id: number;
  result?: unknown;
  error?: string;
};
type Packet =
  | { kind: "request"; id: number; method: string; params: unknown }
  | { kind: "reply"; id: number; result?: unknown; error?: string };

const MAX_PENDING = 128;
const MAX_MESSAGE = 1_048_576;

export class RunnerLinkLost extends Error {
  constructor(
    message: string,
    readonly sent: boolean,
  ) {
    super(message);
  }
}

/** One generation-scoped, bidirectional RPC link. Disconnect never replays writes. */
export class RunnerLink {
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private handler: (method: string, params: unknown) => Promise<unknown>;
  constructor(
    private socket: WebSocket,
    handler: (method: string, params: unknown) => Promise<unknown>,
    private acceptFrame: () => boolean = () => true,
  ) {
    this.handler = handler;
    socket.on("message", (raw, binary) => {
      // The machine credential can be revoked after WS handshake. Refuse the
      // frame before reading or decoding the message body, even for replies.
      if (!this.acceptFrame()) return socket.close(1008);
      const data = Array.isArray(raw)
        ? Buffer.concat(raw)
        : Buffer.from(raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw);
      if (binary || data.length > MAX_MESSAGE) return socket.close(1009);
      let packet: Packet;
      try {
        packet = JSON.parse(data.toString("utf8")) as Packet;
        if (
          typeof packet !== "object" ||
          packet === null ||
          !Number.isSafeInteger(packet.id) ||
          packet.id < 1 ||
          (packet.kind !== "request" && packet.kind !== "reply")
        )
          throw new Error("invalid packet");
      } catch {
        return socket.close(1002);
      }
      if (packet.kind === "reply") {
        const pending = this.pending.get(packet.id);
        if (!pending) return;
        this.pending.delete(packet.id);
        clearTimeout(pending.timer);
        if (packet.error) pending.reject(new Error(packet.error));
        else pending.resolve(packet.result);
        return;
      }
      if (typeof packet.method !== "string" || !packet.method)
        return socket.close(1002);
      void this.handle(packet);
    });
    socket.once("close", () => this.failAll());
    socket.once("error", () => this.failAll());
  }
  private async handle(packet: RunnerRequest) {
    try {
      const result = await this.handler(packet.method, packet.params);
      this.send({ kind: "reply", id: packet.id, result });
    } catch (error) {
      // Never serialize a caught stack, environment, token, or provider body.
      const message =
        error instanceof Error && "statusCode" in error
          ? error.message.slice(0, 256)
          : "运行器处理失败";
      this.send({ kind: "reply", id: packet.id, error: message });
    }
  }
  private send(packet: Packet) {
    if (this.socket.readyState !== this.socket.OPEN) return false;
    this.socket.send(JSON.stringify(packet));
    return true;
  }
  request<T>(method: string, params: unknown, timeoutMs = 30_000) {
    if (this.socket.readyState !== this.socket.OPEN)
      return Promise.reject(new RunnerLinkLost("运行器连接已断开", false));
    if (this.pending.size >= MAX_PENDING)
      return Promise.reject(new RunnerLinkLost("运行器请求队列已满", false));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RunnerLinkLost("运行器请求超时，结果待核对", true));
      }, timeoutMs).unref();
      this.pending.set(id, {
        resolve: (result) => resolve(result as T),
        reject,
        timer,
      });
      if (!this.send({ kind: "request", id, method, params })) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new RunnerLinkLost("运行器连接已断开", false));
      }
    });
  }
  get connected() {
    return this.socket.readyState === this.socket.OPEN;
  }
  close() {
    this.socket.close();
    this.failAll();
  }
  private failAll() {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(
        new RunnerLinkLost("运行器连接已断开，已发请求结果待核对", true),
      );
    }
    this.pending.clear();
  }
}
