import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { RunnerLink, RunnerLinkLost } from "./runner-link.ts";
import { Problem } from "./problem.ts";

export type RunnerPrincipal = { runnerId: string; credentialId: string };
export type RunnerAuthorization = (
  bearer: string,
) => Promise<RunnerPrincipal | null> | RunnerPrincipal | null;

type Active = {
  link: RunnerLink;
  socket: WebSocket;
  principal: RunnerPrincipal;
  generation: string;
  acpPid: number;
  mcpPort: number;
};

/** Machine authentication is supplied by #192. No callback => no access. */
export class RunnerBridge {
  private server = new WebSocketServer({
    noServer: true,
    maxPayload: 1_048_576,
  });
  private active = new Map<string, Active>();
  private locked = new Map<string, "alive" | "unknown">();
  private accepting = true;
  private onUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => {
    let path: string;
    try {
      path = new URL(request.url ?? "", "http://localhost").pathname;
    } catch {
      return this.reject(socket, 400);
    }
    if (path !== "/runner/v1") return this.reject(socket, 404);
    void this.accept(request, socket, head);
  };
  constructor(
    private http: Server,
    private authorize: RunnerAuthorization,
    private stillValid: (principal: RunnerPrincipal) => boolean,
    private ownerOf: (agentId: string) => {
      runner_id: string;
      generation: string;
    } | null,
    private handle: (
      principal: RunnerPrincipal,
      method: string,
      params: unknown,
    ) => Promise<unknown>,
    private refOf: (agentId: string) => string = (id) => id,
  ) {
    http.on("upgrade", this.onUpgrade);
  }
  private reject(socket: Duplex, code: number) {
    if (!socket.writable) return socket.destroy();
    socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\n\r\n`);
  }
  private async accept(request: IncomingMessage, socket: Duplex, head: Buffer) {
    if (!this.accepting) return this.reject(socket, 503);
    const match = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? "");
    const generation = request.headers["x-atrium-generation"];
    const pid = Number(request.headers["x-atrium-acp-pid"]);
    const mcpPort = Number(request.headers["x-atrium-mcp-port"]);
    if (
      !match ||
      typeof generation !== "string" ||
      !/^[\w-]{8,64}$/.test(generation) ||
      !Number.isSafeInteger(pid) ||
      pid < 1 ||
      !Number.isSafeInteger(mcpPort) ||
      mcpPort < 1 ||
      mcpPort > 65535
    )
      return this.reject(socket, 401);
    let principal: RunnerPrincipal | null;
    try {
      principal = await this.authorize(match[1]);
    } catch {
      return this.reject(socket, 401);
    }
    if (!principal) return this.reject(socket, 401);
    if (this.active.has(principal.runnerId)) return this.reject(socket, 409);
    if (!this.accepting) return this.reject(socket, 503);
    this.server.handleUpgrade(request, socket, head, (websocket) => {
      const active: Active = {
        socket: websocket,
        principal,
        generation,
        acpPid: pid,
        mcpPort,
        link: new RunnerLink(
          websocket,
          (method, params) => {
            if (!this.stillValid(principal)) {
              this.revokeCredential(principal.credentialId);
              throw new Error("machine credential revoked");
            }
            if (
              method !== "runner.heartbeat" &&
              method !== "runner.reconcile"
            ) {
              const agentId =
                typeof params === "object" &&
                params !== null &&
                "agentId" in params
                  ? params.agentId
                  : null;
              const owner =
                typeof agentId === "string" ? this.ownerOf(agentId) : null;
              if (
                owner?.runner_id !== principal.runnerId ||
                owner.generation !== generation
              )
                throw new Error("runner does not own identity");
            }
            return this.handle(principal, method, params);
          },
          () => {
            if (this.stillValid(principal)) return true;
            this.revokeCredential(principal.credentialId);
            return false;
          },
        ),
      };
      this.active.set(principal.runnerId, active);
      websocket.once("close", () => {
        if (this.active.get(principal.runnerId) === active)
          this.active.delete(principal.runnerId);
      });
    });
  }
  markRecovery(rebound: string[], locked: Record<string, "alive" | "unknown">) {
    for (const id of rebound) this.locked.delete(id);
    for (const [id, reason] of Object.entries(locked))
      this.locked.set(id, reason);
  }
  /** All control-plane requests go through the persisted identity ownership. */
  requestFor<T>(agentId: string, method: string, params: unknown): Promise<T> {
    const owner = this.ownerOf(agentId);
    const active = owner ? this.active.get(owner.runner_id) : null;
    if (owner && active && active.generation !== owner.generation) {
      const reason = this.locked.get(agentId);
      if (reason)
        return Promise.reject(
          new Problem(
            409,
            reason === "alive"
              ? `旧进程仍在运行；确认后执行 atrium runner reclaim ${this.refOf(agentId)}`
              : `无法确认旧进程已退出；核查后执行 atrium runner reclaim ${this.refOf(agentId)}`,
            "runner_locked",
            undefined,
            `atrium runner reclaim ${this.refOf(agentId)}`,
          ),
        );
    }
    if (
      !owner ||
      !active ||
      active.generation !== owner.generation ||
      !this.stillValid(active.principal)
    )
      return Promise.reject(
        new Problem(
          503,
          "身份运行器不可用，命令未发送；检查运行器连接后重试",
          "runner_offline",
        ),
      );
    return active.link
      .request<T>(method, { agentId, params })
      .catch((error: unknown) => {
        if (error instanceof RunnerLinkLost)
          throw error.sent
            ? new Problem(
                503,
                "运行器连接中断，命令可能已执行；先查询状态再重试",
                "runner_outcome_unknown",
              )
            : new Problem(
                503,
                "运行器连接已断开，命令未发送；稍后重试",
                "runner_offline",
              );
        throw error;
      });
  }
  /** Administrative control still requires a live, non-revoked machine credential. */
  requestControl<T>(
    runnerId: string,
    method: string,
    params: unknown,
  ): Promise<T> {
    const active = this.active.get(runnerId);
    if (!active || !this.stillValid(active.principal))
      return Promise.reject(
        new Problem(503, "运行器未连接或凭据已撤销", "runner_offline"),
      );
    return active.link.request<T>(method, params);
  }
  connected(runnerId: string) {
    return this.active.has(runnerId);
  }
  acpPid(runnerId: string) {
    return this.active.get(runnerId)?.acpPid ?? null;
  }
  generation(runnerId: string) {
    return this.active.get(runnerId)?.generation ?? null;
  }
  async mcpUrl(agentId: string) {
    // The capability is created by the local runner and never stored on Web.
    const result = await this.requestFor<{ url: string }>(
      agentId,
      "mcp.url",
      {},
    );
    return result.url;
  }
  revokeCredential(credentialId: string) {
    for (const active of this.active.values()) {
      if (active.principal.credentialId !== credentialId) continue;
      active.socket.close(4003, "credential revoked");
      this.active.delete(active.principal.runnerId);
    }
  }
  close() {
    this.accepting = false;
    this.http.off("upgrade", this.onUpgrade);
    for (const active of this.active.values()) active.link.close();
    this.active.clear();
    this.server.close();
  }
}
