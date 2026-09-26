import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Problem } from "./problem.ts";

const MAX_FRAME = 4 * 1024 * 1024;
const MAX_RESPONSE = 2 * 1024 * 1024;
const MAX_IN_FLIGHT = 16;
export const CONTAINER_MCP_URL = "http://127.0.0.1:19671/mcp";

type Frame = { id: number; body: string; accept: string; protocol: string };
export type ContainerMcpOwner = {
  agentId: string;
  generation: string;
  containerId: string;
};

/** A container's old exec stream is not authorized after any ownership change. */
export function sameContainerMcpOwner(
  bound: ContainerMcpOwner,
  current: ContainerMcpOwner | null,
) {
  return (
    current !== null &&
    bound.agentId === current.agentId &&
    bound.generation === current.generation &&
    bound.containerId === current.containerId
  );
}

function dockerHelper(containerId: string): ChildProcessWithoutNullStreams {
  return spawn(
    "docker",
    [
      "exec",
      "-i",
      "--user",
      "1000:1000",
      containerId,
      "node",
      "/opt/atrium/agent-helper.mjs",
    ],
    { env: { PATH: process.env.PATH }, stdio: "pipe" },
  );
}

/** The exec stream is the only transport out of this container namespace. Its host URL is secret. */
export class ContainerMcpBridge {
  private exec: ChildProcessWithoutNullStreams | undefined;
  private pending = 0;
  private accepting = false;
  private allowNew = true;
  private partial = "";
  constructor(
    private containerId: string,
    private hostUrl: string,
    private stillOwned: () => boolean,
    private spawnHelper: (
      containerId: string,
    ) => ChildProcessWithoutNullStreams = dockerHelper,
  ) {}

  async start() {
    if (this.exec) throw new Error("MCP bridge already started");
    const child = this.spawnHelper(this.containerId);
    this.exec = child;
    const ready = new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Problem(409, "容器 MCP helper 未就绪")),
        6000,
      );
      const settle = (error?: Error) => {
        clearTimeout(deadline);
        if (error) reject(error);
        else resolve();
      };
      child.once("error", () =>
        settle(new Problem(409, "容器 MCP helper 无法启动")),
      );
      child.once("close", () => {
        this.accepting = false;
        settle(new Problem(409, "容器 MCP helper 已退出"));
      });
      child.stdin.on("error", () => {
        this.accepting = false;
      });
      child.stdout.on("data", (chunk: Buffer) => {
        this.partial += chunk.toString("utf8");
        if (this.partial.length > MAX_FRAME) {
          this.accepting = false;
          child.kill();
          settle(new Problem(409, "容器 MCP 帧超出上限"));
          return;
        }
        let split: number;
        while ((split = this.partial.indexOf("\n")) >= 0) {
          const line = this.partial.slice(0, split);
          this.partial = this.partial.slice(split + 1);
          let message: Frame | { ready: boolean };
          try {
            message = JSON.parse(line);
          } catch {
            this.accepting = false;
            child.kill();
            settle(new Problem(409, "容器 MCP 帧无效"));
            return;
          }
          if ("ready" in message) {
            this.accepting = true;
            settle();
          } else {
            void this.forward(message).catch(() => undefined);
          }
        }
      });
    });
    try {
      await ready;
    } catch (error) {
      this.accepting = false;
      child.kill();
      throw error;
    }
  }

  private async forward(frame: Frame) {
    if (!this.accepting) return;
    if (
      !Number.isSafeInteger(frame.id) ||
      frame.id < 0 ||
      typeof frame.body !== "string" ||
      frame.body.length > MAX_FRAME ||
      typeof frame.accept !== "string" ||
      typeof frame.protocol !== "string"
    )
      return;
    if (!this.allowNew || !this.stillOwned()) {
      this.send({ id: frame.id, status: 403, body: "" });
      return;
    }
    if (this.pending >= MAX_IN_FLIGHT) {
      this.send({ id: frame.id, status: 429, body: "" });
      return;
    }
    this.pending++;
    try {
      const payload = Buffer.from(frame.body, "base64");
      if (payload.length > MAX_RESPONSE) {
        this.send({ id: frame.id, status: 413, body: "" });
        return;
      }
      const result = await fetch(this.hostUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: frame.accept.slice(0, 256),
          ...(frame.protocol
            ? { "mcp-protocol-version": frame.protocol.slice(0, 64) }
            : {}),
        },
        body: payload,
        redirect: "error",
        signal: AbortSignal.timeout(45_000),
      });
      const reader = result.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader)
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > MAX_RESPONSE) {
            await reader.cancel();
            throw new Error("MCP reply too large");
          }
          chunks.push(value);
        }
      if (this.accepting && this.stillOwned())
        this.send({
          id: frame.id,
          status: result.status,
          contentType: result.headers.get("content-type") ?? "application/json",
          sessionId: result.headers.get("mcp-session-id"),
          body: Buffer.concat(chunks).toString("base64"),
        });
    } catch {
      if (this.accepting && this.stillOwned())
        this.send({ id: frame.id, status: 502, body: "" });
    } finally {
      this.pending--;
    }
  }

  private send(frame: unknown) {
    this.exec?.stdin.write(JSON.stringify(frame) + "\n");
  }

  /** Stop accepting new calls; a timeout means the owner must remain locked. */
  async drain(timeoutMs = 50_000) {
    this.allowNew = false;
    const until = Date.now() + timeoutMs;
    while (this.pending && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 50));
    if (this.pending === 0) this.accepting = false;
    return this.pending === 0;
  }

  close() {
    this.accepting = false;
    this.exec?.stdin.end();
    this.exec?.kill("SIGTERM");
    this.exec = undefined;
  }
}
