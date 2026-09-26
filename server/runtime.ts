import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientConnection,
} from "@agentclientprotocol/sdk";
import {
  bridgeReadinessProblem,
  errorWithDetails,
  isAuthOrCapabilityFailure,
} from "./runtime-error.ts";
import { z } from "zod";
import {
  runtimeSchema,
  liveRuntimeSchema,
  type RuntimeInfo,
  type LiveRuntime,
} from "../shared/schema.ts";
import {
  formatModelSpec,
  type ModelChange,
  type ModelSpec,
  type ModelState,
  type ModelOption,
} from "../shared/model.ts";
import { Store, Problem } from "./store.ts";
import { ensureOwnPackages } from "./identity-packages.ts";
import { migrateTemplateLinks } from "./identity-links.ts";
import { atriumGuide } from "./mcp.ts";
import {
  prepareProfile,
  readIdentityModel,
  restoreIdentityModel,
  snapshotIdentityModel,
  syncIdentityProfile,
} from "./profile.ts";
import {
  configuredModel,
  configureModel,
  liveThinkingProblem,
  offlineModels,
  rememberModels,
} from "./model.ts";
import {
  ensureDesktopCwd,
  linkProfile,
  removeCredential,
  resolvePiHome,
  unlinkProfile,
} from "./agents.ts";
import { TraceStore } from "./trace.ts";
import { TurnLedger, settleFailure } from "./turns.ts";
import { runtimeEvents } from "../shared/trace.ts";
import { agentTransition } from "./agent-failure.ts";
import { notifyTerminal } from "./incident-notice.ts";
import { needsUserAttempt } from "./incident.ts";
import { hasAssignment, requireAssignment, UNASSIGNED } from "./assignment.ts";
import { assignedSetupTokenRef } from "./launch-account.ts";
import {
  assertIdentityLaunchSecretCapability,
  supportsIdentityLaunchSecret,
} from "./launch-capability.ts";
import { commandAgent } from "../shared/command-agent.ts";
import { executable, mergeNotices, wakesOffline } from "./delivery.ts";
import { ownerOf, rebindStopped, releaseRunner } from "./runner-ownership.ts";
import type { RunnerBridge } from "./runner-bridge.ts";

const require = createRequire(import.meta.url);
// 服务可能从某个 herdr pane 里启动；后台身份不在那个 pane 里，去掉表示「身处此 pane」的变量，
// 只留连接 herdr 所需的 socket 与可执行文件路径。
const paneScoped = [
  "HERDR_ENV",
  "HERDR_PANE_ID",
  "HERDR_TAB_ID",
  "HERDR_WORKSPACE_ID",
];
export function identityEnvironment(env: NodeJS.ProcessEnv) {
  const predicate = (
    require("@liuser/pi-atrium/dist/identity.js") as {
      isInheritedModelCredential?: (name: string) => boolean;
    }
  ).isInheritedModelCredential;
  if (typeof predicate !== "function")
    throw new Problem(
      409,
      "pi-atrium 未提供模型凭据隔离规则；全局安装请运行 atrium update，源码安装请在仓库执行 npm ci，随后运行 atrium restart",
      "launch_secret_unsupported",
    );
  const result = { ...env };
  for (const key of Object.keys(result)) {
    if (paneScoped.includes(key) || predicate(key)) delete result[key];
  }
  return result;
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};
type Binding = {
  runtime_id: string | null;
  runtime_pid: number | null;
  acp_session_id: string | null;
  session_file: string | null;
};
type Gateway = {
  connection: ClientConnection;
  child: ChildProcessWithoutNullStreams;
  closed: Promise<void>;
  launchSecretCapable: boolean;
  stopping?: Promise<void>;
};
const target = (r: RuntimeInfo) => ({
  runtimeId: r.runtimeId,
  generation: r.generation,
  sessionId: r.sessionId,
});
// 接入说明按正文取 id：同一会话同一版说明只送一次，说明改了就自动换 id 重送。
// pi-atrium 对同一 id 换了正文的投递会报错，所以不能靠手工改版本号。
const guideId = (agent: string, session: string) => {
  const h = createHash("sha256")
    .update(`${agent}:${session}:guide:${atriumGuide}`)
    .digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

/** Business-side ACP client. Pi processes, IPC discovery and native context belong to pi-atrium. */
export class Runtimes {
  readonly connections = new Map<
    string,
    { connection: ClientConnection | null; info: RuntimeInfo }
  >();
  readonly errors = new Map<string, string>();
  readonly traceErrors = new Map<string, string>();
  readonly traces: TraceStore;
  readonly turns: TurnLedger;
  private manuallyRetrying = new Set<string>();
  private explicitlyRetrying = new Set<string>();
  private readonly userAttempt = new Map<string, number>();
  private readonly retryOwner = randomUUID();
  private idleAccepted = new Map<
    string,
    { runtime: string; generation: string; since: number }
  >();
  private traceLag = new Set<string>();
  private gateway?: Gateway;
  private bridge?: RunnerBridge;
  private gateways = new Set<Gateway>();
  private opening?: Promise<Gateway>;
  private connecting = new Map<string, Promise<void>>();
  private switching = new Set<string>();
  private migrationLocks = new Map<string, number>();
  private bindingOwners = new Map<string, string>();
  private pumping = new Map<string, Promise<void>>();
  private lastTurn = new Map<
    string,
    {
      generation: string;
      at: number;
      deliveryAt: number | null;
      successful: boolean;
    }
  >();
  private starts = new Map<string, { at: number; failures: number }>();
  /** Only the first turn of a restored, locally owned session may be replaced. */
  private restored = new Map<string, string>();
  private recovery = new Map<string, string>();
  private stopped = false;
  private discovered: LiveRuntime[] = [];
  private discoveryError: string | null = null;
  private discoveredOnce = false;
  /** 当前网关支不支持当场切模型；不支持也照常跑，只是改动要等重启。 */
  private canSetModel = false;
  private scanning?: Promise<void>;
  private ticking = false;
  private draining = false;
  public gatewayVersion: string | null = null;
  public needsReload = new Set<string>();
  private interval: NodeJS.Timeout;
  constructor(
    private store: Store,
    private data: string,
    private changed: () => void,
    private baseUrl: () => string,
    private piHome: string | undefined,
    private desktops: string,
    private redact: (agent: string, text: string) => string = (_, text) => text,
    private authFailure: (agent: string, detail: string) => void = () => {},
  ) {
    this.traces = new TraceStore(store, redact);
    this.turns = new TurnLedger(store, redact);
    mkdirSync(join(data, "credentials"), { recursive: true, mode: 0o700 });
    this.interval = setInterval(() => {
      void this.tick();
    }, 3000).unref();
    void this.discover();
  }
  setBridge(bridge: RunnerBridge) {
    this.bridge = bridge;
    void this.discover();
  }
  runnerGeneration(runnerId: string) {
    return this.bridge?.generation(runnerId) ?? null;
  }
  private runnerRevoked(runnerId: string) {
    return !!this.store.one(
      "SELECT 1 FROM runners WHERE number=? AND revoked_at IS NOT NULL",
      Number(runnerId.slice(1)),
    );
  }
  noteRunnerRecovery(
    rebound: string[],
    locked: Record<string, "alive" | "unknown">,
  ) {
    this.bridge?.markRecovery(rebound, locked);
    for (const id of rebound) {
      this.connections.delete(id);
      this.restored.delete(id);
      this.errors.delete(id);
    }
    for (const [id, status] of Object.entries(locked)) {
      const ref = this.store.agent(id).ref;
      this.errors.set(
        id,
        status === "alive"
          ? `旧进程仍在运行；确认后执行 atrium runner reclaim ${ref}`
          : `无法确认旧进程已退出；核查后执行 atrium runner reclaim ${ref}`,
      );
    }
    if (rebound.length || Object.keys(locked).length) this.changed();
  }
  async drainRunner(
    agentId: string,
    action: "start" | "status" | "resume" | "inspect",
  ) {
    const owner = ownerOf(this.store, agentId);
    if (!owner) throw new Problem(404, "身份没有运行器归属");
    if (
      this.runnerRevoked(owner.runner_id) ||
      !this.bridge ||
      this.bridge.generation(owner.runner_id) !== owner.generation
    )
      throw new Problem(
        503,
        "归属运行器未连接或代际已变化；不能确认排空",
        "runner_offline",
      );
    const result = await this.bridge.requestControl<{
      drained?: boolean;
      draining?: boolean;
      busy?: string[];
    }>(owner.runner_id, "runner.drain", { agentId, action });
    const current = ownerOf(this.store, agentId);
    if (
      current?.runner_id !== owner.runner_id ||
      current.generation !== owner.generation ||
      this.bridge.generation(owner.runner_id) !== owner.generation
    )
      throw new Problem(
        409,
        "身份运行器归属或代际已变化；不能确认排空",
        "runner_changed",
      );
    return result;
  }
  /** A due retry cannot claim its attempt while its remote identity is draining. */
  private async retryRunnerReady(agentId: string) {
    if (!ownerOf(this.store, agentId)) return true;
    try {
      return (await this.drainRunner(agentId, "inspect")).draining === false;
    } catch {
      // An offline or changed runner cannot safely accept a new turn either.
      return false;
    }
  }
  async reclaimRunner(agentId: string, confirmStopped: boolean) {
    const owner = ownerOf(this.store, agentId);
    if (!owner || !this.bridge) throw new Problem(404, "身份没有运行器归属");
    if (this.runnerRevoked(owner.runner_id)) {
      const command = `atrium runner reclaim ${this.store.agent(agentId).ref} --confirm-stopped`;
      if (!confirmStopped)
        throw new Problem(
          409,
          `归属运行器 ${owner.runner_id} 已撤销；确认旧 Pi 已停止后执行 ${command}`,
          "runner_locked",
          undefined,
          command,
        );
      this.store.transaction(() => {
        if (
          !releaseRunner(
            this.store,
            agentId,
            owner.runner_id,
            owner.generation,
            true,
          )
        )
          throw new Problem(409, "身份运行器归属已变化，请重新查询");
        this.store.run(
          "UPDATE agents SET runtime_id=NULL,runtime_pid=NULL WHERE id=?",
          agentId,
        );
      });
      this.connections.delete(agentId);
      this.restored.delete(agentId);
      this.errors.delete(agentId);
      this.discovered = this.discovered.filter(
        (item) => item.bound_agent !== agentId,
      );
      this.changed();
      return { recovered: true, released: true };
    }
    if (
      this.connections.has(agentId) &&
      this.bridge.generation(owner.runner_id) === owner.generation
    )
      throw new Problem(409, "当前会话仍在运行，请先停止");
    const report = await this.bridge.requestControl<{
      status: "exited" | "alive" | "unknown";
    }>(owner.runner_id, "runner.reclaim", { agentId, confirmStopped });
    if (report.status !== "exited")
      throw new Problem(
        409,
        "旧进程未确认退出，身份仍被锁住；请先检查并停止旧进程",
      );
    const outcome = rebindStopped(
      this.store,
      owner.runner_id,
      owner.generation,
      this.bridge.generation(owner.runner_id)!,
      { [agentId]: "exited" },
      "unknown",
    );
    this.noteRunnerRecovery(outcome.rebound, outcome.locked);
    return { recovered: outcome.rebound.includes(agentId) };
  }
  async runnerStopped(agentId: string) {
    if (this.connections.has(agentId)) return false;
    const owner = ownerOf(this.store, agentId);
    if (!owner || this.bridge?.generation(owner.runner_id) !== owner.generation)
      return false;
    const { runtimes } = z
      .object({
        runtimes: z
          .array(
            liveRuntimeSchema.extend({
              bound_agent: z.string().nullable().optional(),
            }),
          )
          .max(256),
      })
      .parse(await this.rpc("_pi/runtime/list", {}, agentId));
    return !runtimes.some(
      (runtime) =>
        runtime.identityId === agentId || runtime.bound_agent === agentId,
    );
  }
  private binding(id: string) {
    this.store.agent(id);
    return this.store.one<Binding>(
      "SELECT runtime_id,runtime_pid,acp_session_id,session_file FROM agents WHERE id=?",
      id,
    )!;
  }
  private assertOpen() {
    if (this.stopped) throw new Error("Atrium 正在关闭");
  }
  private async open(): Promise<Gateway> {
    this.assertOpen();
    if (this.gateway) return this.gateway;
    if (this.opening) return this.opening;
    const opening = (async () => {
      const entry =
        process.env.ATRIUM_PI_ACP_ENTRY ||
        require.resolve("@liuser/pi-atrium/dist/index.js");
      const child = spawn(process.execPath, [entry], {
        env: {
          ...identityEnvironment(process.env),
          PI_ACP_LAUNCH_SECRET_ROOT: join(resolve(this.data), "accounts"),
          PI_MCP_TOOL_EXPOSURE: "proxy-only",
          PI_ACP_PI_COMMAND:
            process.env.PI_ACP_PI_COMMAND || process.env.ATRIUM_PI_BIN || "pi",
        },
        stdio: "pipe",
      });
      // Keep provider/adapter diagnostics local; never forward credentials or RPC payloads to the UI.
      child.stderr.on("data", (data: Buffer) => process.stderr.write(data));
      const connection = client({ name: "atrium" })
        .onRequest("session/request_permission", () => ({
          outcome: { outcome: "cancelled" },
        }))
        .onNotification("session/update", () => undefined)
        .connect(
          ndJsonStream(
            Writable.toWeb(child.stdin),
            // Node/DOM BYOB declarations differ; this is the native byte Web Stream.
            Readable.toWeb(
              child.stdout,
            ) as unknown as ReadableStream<Uint8Array>,
          ),
        );
      child.once("error", (error) => connection.close(error));
      const closed = new Promise<void>((resolve) => {
        child.once("close", () => resolve());
      });
      const gateway: Gateway = {
        connection,
        child,
        closed,
        launchSecretCapable: false,
      };
      this.gateways.add(gateway);
      void closed.then(() => this.gateways.delete(gateway));
      void connection.closed
        .catch(() => undefined)
        .then(() => this.stopGateway(gateway));
      const timeout = setTimeout(
        () => connection.close(new Error("pi-acp 初始化超时")),
        15000,
      ).unref();
      try {
        const result = await connection.agent.request<{
          protocolVersion?: number;
          agentInfo?: { name?: string; version?: string };
          _meta?: Record<string, unknown>;
        }>("initialize", {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: "atrium" },
        });
        if (
          !result._meta?.["pi-acp/runtime/v1"] ||
          !result._meta?.["pi-acp/identity/v1"]
        )
          throw new Error(
            "pi-atrium 缺少 runtime/v1 能力，请更新到本项目要求的版本",
          );
        this.gatewayVersion = result.agentInfo?.version ?? null;
        this.canSetModel = !!result._meta["pi-acp/identity/model/v1"];
        gateway.launchSecretCapable = supportsIdentityLaunchSecret(
          result._meta,
        );
        this.assertOpen();
        this.gateway = gateway;
        void connection.closed
          .catch(() => undefined)
          .then(() => {
            if (this.gateway !== gateway) return;
            this.gateway = undefined;
            for (const [id, entry] of this.connections)
              if (entry.connection === connection) {
                this.connections.delete(id);
                if (!this.stopped)
                  this.errors.set(id, "pi-atrium 连接断开，正在等待重连");
              }
            this.changed();
          });
        return gateway;
      } catch (error) {
        await this.stopGateway(gateway);
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    })();
    this.opening = opening;
    try {
      return await opening;
    } finally {
      if (this.opening === opening) this.opening = undefined;
    }
  }
  private async rpc<T = Record<string, unknown>>(
    method: string,
    params: unknown,
    agentId?: string,
  ): Promise<T> {
    const owner = agentId ? ownerOf(this.store, agentId) : null;
    if (owner) {
      if (!this.bridge) throw new Problem(503, "身份运行器未就绪，未发出命令");
      return this.bridge.requestFor<T>(agentId!, "acp.request", {
        method,
        params,
      });
    }
    const { connection } = await this.open();
    try {
      return await connection.agent.request<T>(method, params);
    } catch (error) {
      // SDK masks server errors as "Internal error"; identity conflicts must tell
      // the operator which process is still occupying it, without exposing RPC payloads.
      const details = (error as { data?: { details?: unknown } })?.data
        ?.details;
      if (method.startsWith("_pi/identity/") && typeof details === "string")
        throw new Problem(
          /already occupied|needs inspection/.test(details) ? 409 : 500,
          details.slice(0, 512),
        );
      throw error;
    }
  }
  async remove(id: string, confirm: string) {
    await this.operation(
      id,
      async () => {
        await this.discover();
        if (this.discoveryError)
          throw new Problem(503, "无法确认运行状态，暂不能删除；请稍后重试");
        if (this.pumping.has(id))
          throw new Problem(409, "Agent 正在处理连接，请稍后重试");
        const { claimIdentity } =
          require("@liuser/pi-atrium/dist/identity.js") as {
            claimIdentity(
              identity: { identityId: string; agentDirectory: string },
              cwd: string,
            ): { release(): void };
          };
        this.store.transaction(() => {
          const agent = this.store.agent(id);
          if (confirm !== agent.ref)
            throw new Problem(400, "删除确认与 Agent 不一致");
          if (this.running(id))
            throw new Problem(
              409,
              "Agent 仍在运行，请先正常停止后再删除",
              undefined,
              undefined,
              `atrium stop ${commandAgent(agent.name, agent.ref)}\n确认删除：atrium delete ${commandAgent(agent.name, agent.ref)} --yes`,
            );
          let lease: { release(): void } | undefined;
          try {
            if (agent.agent_directory) {
              try {
                lease = claimIdentity(
                  { identityId: id, agentDirectory: agent.agent_directory },
                  agent.cwd,
                );
              } catch {
                throw new Problem(
                  409,
                  "身份仍被占用或状态不明，请先正常停止 Agent 后重试",
                );
              }
            }
            this.store.deleteAgent(id);
            if (agent.agent_directory)
              unlinkProfile(resolvePiHome(this.piHome), agent.name);
          } finally {
            lease?.release();
          }
        });
        // After the commit: the revocation is recorded, so losing the file cannot
        // strip a live identity of its token.
        removeCredential(this.data, id);
        this.connections.delete(id);
        this.errors.delete(id);
        this.starts.delete(id);
        this.changed();
      },
      "ignore",
    );
  }
  private withOwners(runtimes: LiveRuntime[]): LiveRuntime[] {
    const rows = this.store.all<
      Binding & {
        id: string;
        cwd: string;
        observed_session_id: string | null;
        agent_directory: string | null;
      }
    >(
      "SELECT id,cwd,runtime_id,runtime_pid,acp_session_id,observed_session_id,session_file,agent_directory FROM agents WHERE deleted_at IS NULL",
    );
    const named = new Map(
      rows.filter((a) => a.agent_directory).map((a) => [a.id, a]),
    );
    const byRuntime = new Map(
      rows
        .filter((a) => !a.agent_directory && a.runtime_id)
        .map((a) => [a.runtime_id, a]),
    );
    const sessionCounts = new Map<string, number>();
    for (const runtime of runtimes)
      sessionCounts.set(
        runtime.sessionId,
        (sessionCounts.get(runtime.sessionId) ?? 0) + 1,
      );
    const bySession = new Map<string, typeof rows>();
    for (const row of rows) {
      const session = row.observed_session_id ?? row.acp_session_id;
      if (session && !row.agent_directory)
        bySession.set(session, [...(bySession.get(session) ?? []), row]);
    }
    return runtimes
      .filter((r) => r.mode === "tui" || r.identityId)
      .map((r) => {
        // Directory equality alone never identifies an Agent. A resumed session may
        // regain its identity only after the previous process has exited.
        const candidates = (bySession.get(r.sessionId) ?? []).filter(
          (a) => a.cwd === r.cwd && (!a.runtime_pid || !alive(a.runtime_pid)),
        );
        const owner = r.identityId
          ? named.get(r.identityId)
          : (byRuntime.get(r.runtimeId) ??
            (sessionCounts.get(r.sessionId) === 1 && candidates.length === 1
              ? candidates[0]
              : undefined));
        return { ...r, bound_agent: owner?.id ?? null };
      });
  }
  async available(): Promise<LiveRuntime[]> {
    const value = await this.rpc("_pi/runtime/list", {});
    const { runtimes: local } = z
      .object({ runtimes: z.array(liveRuntimeSchema).max(256) })
      .parse(value);
    // A remote runner's paths belong to its host; the Web host must not
    // resolve them against its own filesystem when deciding ownership.
    const runtimes = local.map((r) => {
      let cwd = r.cwd;
      try {
        cwd = realpathSync(cwd);
      } catch {
        /* Preserve display metadata for inaccessible directories. */
      }
      return { ...r, cwd };
    });
    const claimed = this.store.all<{
      agent_id: string;
      runner_id: string;
    }>("SELECT agent_id,runner_id FROM runner_ownership");
    const seen = new Set<string>();
    for (const { agent_id, runner_id } of claimed) {
      if (seen.has(runner_id) || !this.bridge?.connected(runner_id)) continue;
      seen.add(runner_id);
      const remote = await this.rpc("_pi/runtime/list", {}, agent_id);
      const parsed = z
        .object({ runtimes: z.array(liveRuntimeSchema).max(256) })
        .parse(remote);
      runtimes.push(...parsed.runtimes);
    }
    return this.withOwners(runtimes);
  }
  directory() {
    return {
      runtimes: this.withOwners(this.discovered),
      scanning: !this.discoveredOnce,
      error: this.discoveryError,
    };
  }
  async discover(): Promise<void> {
    if (this.stopped) return;
    if (this.scanning) return this.scanning;
    const before = JSON.stringify(this.directory());
    this.scanning = (async () => {
      try {
        const found = await this.available();
        if (this.stopped) return;
        this.discovered = found;
        this.discoveryError = null;
        // Reconcile known identities only. Merely opening the directory neither
        // creates accounts nor connects to or modifies unrelated Pi sessions.
        for (const runtime of found) {
          if (!runtime.bound_agent) continue;
          this.store.run(
            "UPDATE agents SET runtime_id=?,runtime_pid=?,observed_session_id=? WHERE id=? AND (runtime_id IS NOT ? OR runtime_pid IS NOT ? OR observed_session_id IS NOT ?)",
            runtime.runtimeId,
            runtime.pid,
            runtime.sessionId,
            runtime.bound_agent,
            runtime.runtimeId,
            runtime.pid,
            runtime.sessionId,
          );
        }
      } catch {
        if (!this.stopped)
          this.discoveryError =
            "暂时无法发现本机 Agent，请确认 pi-atrium 可用。";
      } finally {
        this.discoveredOnce = true;
        this.scanning = undefined;
        if (!this.stopped && before !== JSON.stringify(this.directory()))
          this.changed();
      }
    })();
    return this.scanning;
  }
  async agentForRuntime(runtimeId: string) {
    await this.discover();
    this.assertOpen();
    if (this.discoveryError) throw new Problem(503, this.discoveryError);
    const runtime = this.directory().runtimes.find(
      (r) => r.runtimeId === runtimeId,
    );
    if (!runtime) throw new Problem(404, "这个 Agent 已离线，请刷新名册");
    if (runtime.bound_agent) {
      requireAssignment(this.store, runtime.bound_agent);
      return this.store.agent(runtime.bound_agent);
    }
    throw new Problem(
      409,
      "这是临时 Pi；请新建长期身份后使用具名入口启动，不会自动创建账号",
    );
  }
  private async services(id: string) {
    const path = join(this.data, "credentials", `${id}.json`);
    if (!existsSync(path)) {
      // Existing installation: keep the credential, move its old transport file out of the retired links directory.
      const legacy = join(this.data, "links", `${id}.json`);
      const value = z
        .object({ agent_id: z.literal(id), token: z.string().min(32).max(128) })
        .parse(JSON.parse(readFileSync(legacy, "utf8")));
      if (!this.store.authenticate(id, value.token))
        throw new Error("旧凭据与 Agent 不一致");
      renameSync(legacy, path);
    }
    const { token } = z
      .object({ token: z.string().min(32).max(128) })
      .parse(JSON.parse(readFileSync(path, "utf8")));
    if (!this.store.authenticate(id, token)) throw new Error("Agent 凭据无效");
    return [
      {
        name: "atrium",
        type: "http",
        url: ownerOf(this.store, id)
          ? await this.bridge!.mcpUrl(id)
          : `${this.baseUrl()}/mcp/${id}`,
        headers: [{ name: "Authorization", value: `Bearer ${token}` }],
      },
    ];
  }
  private remember(id: string, info: RuntimeInfo) {
    const previous = this.binding(id);
    if (
      previous.runtime_id === info.runtimeId &&
      previous.runtime_pid === info.pid &&
      previous.acp_session_id === info.sessionId &&
      previous.session_file === info.sessionFile
    )
      return;
    this.store.run(
      "UPDATE agents SET runtime_id=?,runtime_pid=?,acp_session_id=?,session_file=?,observed_session_id=? WHERE id=?",
      info.runtimeId,
      info.pid,
      info.sessionId,
      info.sessionFile,
      info.sessionId,
      id,
    );
  }
  private async bind(
    id: string,
    selector: { runtimeId: string } | { sessionId: string },
  ) {
    const selected = "runtimeId" in selector ? selector.runtimeId : undefined;
    if (selected) {
      if (
        (this.bindingOwners.has(selected) &&
          this.bindingOwners.get(selected) !== id) ||
        this.store.one(
          "SELECT id FROM agents WHERE runtime_id=? AND id<>?",
          selected,
          id,
        )
      )
        throw new Problem(409, "这个 Pi 已绑定或正在接入另一个 Agent");
      this.bindingOwners.set(selected, id);
    }
    let info: RuntimeInfo | undefined;
    let continuing = false;
    try {
      const previous = this.binding(id);
      const held =
        selected && ownerOf(this.store, id) && previous.runtime_id === selected
          ? this.discovered.find(
              (runtime) =>
                runtime.runtimeId === selected && runtime.identityId === id,
            )
          : undefined;
      if (held) {
        try {
          // The runner's ACP peer survives Web restarts; a second attach on
          // that peer is rejected. Its MCP service and guide also survive.
          info = runtimeSchema.parse(
            await this.rpc(
              "_pi/runtime/status",
              { runtimeId: held.runtimeId, generation: held.generation },
              id,
            ),
          );
          continuing =
            previous.acp_session_id === info.sessionId &&
            previous.session_file === info.sessionFile;
        } catch {
          // The runner may have lost its old ACP peer; attach normally.
        }
      }
      info ??= runtimeSchema.parse(
        await this.rpc("_pi/runtime/attach", selector, id),
      );
      const profile = this.store.agent(id);
      if (profile.agent_directory && info.identityId !== id)
        throw new Problem(409, "运行实例不属于这个长期身份");
      if (
        !ownerOf(this.store, id) &&
        realpathSync(info.cwd) !== realpathSync(profile.cwd)
      )
        throw new Problem(409, "Pi 工作目录与 Agent 配置不一致");
      if (
        this.store.one(
          "SELECT id FROM agents WHERE runtime_id=? AND id<>?",
          info.runtimeId,
          id,
        )
      )
        throw new Problem(409, "这个 Pi 已绑定另一个 Agent");
      if (!continuing) {
        await this.rpc(
          "_pi/runtime/mcp",
          {
            ...target(info),
            mcpServers: await this.services(id),
          },
          id,
        );
        await this.rpc(
          "_pi/runtime/deliver",
          {
            ...target(info),
            id: guideId(id, info.sessionId),
            source: "Atrium 接入说明",
            text: atriumGuide,
            delivery: "steer",
            triggerTurn: false,
          },
          id,
        );
      }
      this.assertOpen();
      this.remember(id, info);
      this.connections.set(id, {
        connection: ownerOf(this.store, id) ? null : this.gateway!.connection,
        info,
      });
      this.errors.delete(id);
      this.changed();
    } catch (error) {
      if (info)
        await this.rpc("_pi/runtime/detach", target(info), id).catch(
          () => undefined,
        );
      throw error;
    } finally {
      if (selected && this.bindingOwners.get(selected) === id)
        this.bindingOwners.delete(selected);
    }
  }
  private async operation(
    id: string,
    run: () => Promise<void>,
    recordFailure: boolean | "ignore" = true,
  ) {
    this.assertOpen();
    if (this.draining) throw new Problem(409, "服务正在排空任务，暂不接入身份");
    if (this.connecting.has(id))
      throw new Problem(409, "Agent 正在接入，请稍候");
    const promise = run().catch((error) => {
      // Deletion rejections are not runtime failures. Other operations still
      // record Problems such as a failed identity start or plugin migration.
      if (
        recordFailure === "ignore" ||
        (error instanceof Problem &&
          (error.code === "runner_offline" ||
            error.code === "runner_draining" ||
            error.code === "runner_outcome_unknown" ||
            error.code === "runner_locked"))
      )
        throw error;
      const message = this.redact(id, errorWithDetails(error));
      if (!this.stopped) {
        this.errors.set(id, message);
        if (recordFailure)
          this.store.setFailure(
            id,
            message,
            Date.now(),
            "startup",
            undefined,
            error instanceof Problem ? error.code : undefined,
          );
        this.changed();
      }
      if (message !== errorWithDetails(error)) throw new Error(message);
      throw error;
    });
    this.connecting.set(id, promise);
    try {
      await promise;
    } finally {
      this.connecting.delete(id);
    }
  }
  async attach(id: string, runtimeId: string) {
    requireAssignment(this.store, id);
    if (this.connections.has(id)) throw new Problem(409, "Agent 已连接");
    await this.operation(id, () => this.bind(id, { runtimeId }));
    await this.pump(id);
  }
  async promote(id: string, template?: string) {
    requireAssignment(this.store, id);
    await this.discover();
    if (this.discoveryError)
      throw new Problem(503, "无法确认旧实例状态，暂不迁移");
    await this.operation(id, async () => {
      const agent = this.store.agent(id),
        binding = this.binding(id);
      if (agent.agent_directory) throw new Problem(409, "已经是长期身份");
      if (
        this.connections.has(id) ||
        (binding.runtime_pid && alive(binding.runtime_pid))
      )
        throw new Problem(
          409,
          "请先正常退出旧 Pi；不会迁移或终止正在运行的实例",
        );
      const home = resolvePiHome(this.piHome);
      const directory = prepareProfile(id, template, home);
      try {
        linkProfile(home, agent.name, directory);
      } catch (error) {
        rmSync(directory, { recursive: true, force: true });
        throw error;
      }
      this.store.run(
        "UPDATE agents SET agent_directory=? WHERE id=?",
        directory,
        id,
      );
      this.changed();
    });
    return this.store.agent(id);
  }
  private recordSessionReset(id: string, reason: string) {
    const safe = this.redact(id, reason).replace(/\s+/g, " ").slice(0, 240);
    this.store.run(
      "UPDATE agents SET session_reset_at=?,session_reset_reason=? WHERE id=?",
      Date.now(),
      safe,
      id,
    );
    console.error(`[Atrium] ${this.store.agent(id).name} 会话已重建：${safe}`);
    this.changed();
  }
  private sessionError(error: unknown) {
    return /prompt-capture|session[^\n]{0,80}(?:not found|invalid|unavailable|corrupt|missing|closed)|(?:invalid|missing|closed|unknown|expired) session/i.test(
      errorWithDetails(error),
    );
  }
  private sameFile(left: string, right: string) {
    const canonical = (path: string) => {
      try {
        return realpathSync(path);
      } catch {
        return resolve(path);
      }
    };
    return canonical(left) === canonical(right);
  }
  /** pi-atrium prefers its identity cursor even when no sessionFile is supplied.
   * Move that pointer aside only after the old writer has stopped; keep the old file.
   */
  private async freshIdentityStart(
    id: string,
    params: Record<string, unknown>,
  ) {
    const cursor = join(
      process.env.PI_ACP_DIR ?? join(homedir(), ".pi", "pi-acp"),
      "identities",
      `${id}.cursor.json`,
    );
    const backup = `${cursor}.reset-${Date.now()}-${randomUUID()}`;
    const moved = existsSync(cursor);
    if (moved) renameSync(cursor, backup);
    try {
      return await this.rpc<{ runtimeId: string }>(
        "_pi/identity/start",
        {
          ...params,
          sessionFile: undefined,
        },
        id,
      );
    } catch (error) {
      if (moved && !existsSync(cursor)) renameSync(backup, cursor);
      throw error;
    }
  }
  /** Stop the old owned runtime before starting a clean session; never delete its file. */
  private async recover(id: string, reason: string) {
    this.recovery.delete(id);
    this.restored.delete(id);
    const runtime = this.connections.get(id);
    if (!runtime || !this.owned(id))
      throw new Error("无法安全替换非本服务启动的会话");
    // run_end may arrive before deliver acknowledges: requeue accepted deliveries now too.
    this.store.finishTurn(id, false);
    if (this.store.agent(id).agent_directory)
      await this.rpc("_pi/identity/stop", { identityId: id }, id);
    else
      await this.rpc(
        "session/close",
        { sessionId: runtime.info.sessionId },
        id,
      );
    this.connections.delete(id);
    this.store.run(
      "UPDATE agents SET runtime_id=NULL,runtime_pid=NULL,observed_session_id=NULL WHERE id=?",
      id,
    );
    await this.start(id, false, true);
    this.recordSessionReset(id, reason);
  }
  async start(id: string, automatic = false, fresh = false) {
    if (this.draining) throw new Problem(409, "服务正在排空任务，暂不启动身份");
    if (this.isMigrating(id))
      throw new Problem(409, "身份正在交接运行器，稍后重试");
    requireAssignment(this.store, id);
    const binding = this.binding(id);
    if (this.switching.has(id) && !fresh)
      throw new Problem(409, "正在切换会话，请稍候");
    const owner = ownerOf(this.store, id);
    if (owner && this.runnerRevoked(owner.runner_id))
      throw new Problem(
        409,
        `归属运行器 ${owner.runner_id} 已撤销；确认旧 Pi 已停止后运行 atrium runner reclaim ${this.store.agent(id).ref} --confirm-stopped`,
        "runner_locked",
      );
    if (this.connections.has(id)) throw new Problem(409, "Agent 已在运行");
    if (
      owner
        ? this.running(id)
        : binding.runtime_pid && alive(binding.runtime_pid)
    )
      throw new Problem(
        409,
        "原 Pi 进程仍可能存在，等待重连；不会另开同一会话",
      );
    const last = this.starts.get(id);
    if (
      automatic &&
      last &&
      (Date.now() - last.at < 60000 || last.failures >= 3)
    )
      return;
    this.starts.set(id, {
      at: Date.now(),
      failures: automatic ? (last?.failures ?? 0) + 1 : 1,
    });
    await this.operation(id, async () => {
      const current = this.store.agent(id);
      const cwd = ensureDesktopCwd(this.store, this.desktops, current);
      if (cwd !== current.cwd) this.changed();
      if (current.agent_directory) {
        // Migrate only when this identity is started, never on service boot.
        // A failed migration must not launch Pi with personal plugins.
        const migrationStarted = Date.now();
        try {
          if (ensureOwnPackages(current.agent_directory)) {
            // Package migration may have created new links after an earlier clean scan.
            this.store.run(
              "DELETE FROM identity_link_migrations WHERE agent_id=?",
              id,
            );
            console.log(
              `${current.name} 的个人 Pi 插件已转为独立安装（${Date.now() - migrationStarted}ms）`,
            );
          }
        } catch (error) {
          console.error(
            `${current.name} 的插件迁移失败（${Date.now() - migrationStarted}ms），保留原配置以便重试：${error}`,
          );
          throw error;
        }
        try {
          const links = migrateTemplateLinks(
            this.store,
            id,
            current.agent_directory,
          );
          if (links.skipped)
            console.log(
              `${current.name} 的模板链接已检查，跳过全量扫描（${links.elapsedMs.toFixed(2)}ms）`,
            );
          else if (links.repaired || links.missing || links.failed)
            console.log(
              `${current.name} 的模板链接已修复 ${links.repaired} 条，保留 ${links.missing} 条，扫描失败 ${links.failed} 条（${links.elapsedMs.toFixed(0)}ms）`,
            );
        } catch (error) {
          console.error(
            `${current.name} 的模板链接修复失败，继续启动：${error}`,
          );
        }
        // A profile left on the old layout costs the Agent a rule, not its session.
        for (const notice of syncIdentityProfile(current.agent_directory))
          console.error(`${current.name} 的${notice}`);
        const configured = readIdentityModel(current.agent_directory);
        const launchAccount = assignedSetupTokenRef(this.store, id);
        if (launchAccount && !ownerOf(this.store, id)) {
          const gateway = await this.open();
          assertIdentityLaunchSecretCapability(gateway.launchSecretCapable);
        }
        const restored = !fresh && !!current.session_file;
        const params = {
          identityId: id,
          agentDirectory: current.agent_directory,
          cwd,
          ...(launchAccount ? { launchSecretAccount: launchAccount } : {}),
          ...(restored ? { sessionFile: current.session_file } : {}),
          // 恢复的会话自带模型记录，会盖过配置默认值；只有启动参数压得住它。
          ...(configured ? { model: formatModelSpec(configured) } : {}),
        };
        let runtimeId: string;
        let restoreError: string | null = null;
        try {
          ({ runtimeId } = fresh
            ? await this.freshIdentityStart(id, params)
            : await this.rpc<{ runtimeId: string }>(
                "_pi/identity/start",
                params,
                id,
              ));
        } catch (error) {
          if (launchAccount) {
            const refusal = bridgeReadinessProblem(error);
            if (refusal) throw refusal;
          }
          if (
            !restored ||
            isAuthOrCapabilityFailure(error) ||
            /already occupied|identity.*occupied/i.test(errorWithDetails(error))
          )
            throw error;
          ({ runtimeId } = await this.freshIdentityStart(id, params));
          fresh = true;
          restoreError = `恢复旧会话失败：${errorWithDetails(error)}`;
        }
        try {
          await this.bind(id, { runtimeId });
          const info = this.connections.get(id)?.info;
          // pi-atrium may accept the start request but silently replace an
          // unreadable session. Treat that as a reset, not a successful restore.
          if (
            restored &&
            !fresh &&
            info &&
            (!info.sessionFile ||
              !this.sameFile(info.sessionFile, current.session_file!))
          ) {
            // The adapter silently skipped the unreadable file. Its cursor may
            // have resumed a DIFFERENT old session: explicitly start fresh.
            await this.rpc("_pi/identity/stop", { identityId: id }, id);
            this.connections.delete(id);
            this.store.run(
              "UPDATE agents SET runtime_id=NULL,runtime_pid=NULL,observed_session_id=NULL WHERE id=?",
              id,
            );
            const replacement = await this.freshIdentityStart(id, params);
            await this.bind(id, replacement);
            restoreError = "原会话无法读取，已新建会话";
          } else if (restored && !fresh && !restoreError && info)
            this.restored.set(id, info.generation);
          if (restoreError) this.recordSessionReset(id, restoreError);
        } catch (error) {
          await this.rpc("_pi/identity/stop", { identityId: id }, id).catch(
            () => undefined,
          );
          throw error;
        }
        return;
      }
      let sessionId = fresh ? null : binding.acp_session_id;
      let restoreError: string | null = null;
      let restored = !!(sessionId || (!fresh && binding.session_file));
      try {
        if (!sessionId && binding.session_file && !fresh) {
          ({ sessionId } = await this.rpc<{ sessionId: string }>(
            "_pi/session/import",
            { cwd, sessionFile: binding.session_file },
            id,
          ));
        }
        if (sessionId)
          await this.rpc(
            "session/load",
            {
              sessionId,
              cwd,
              mcpServers: await this.services(id),
            },
            id,
          );
      } catch (error) {
        if (sessionId)
          await this.rpc("session/close", { sessionId }, id).catch(
            () => undefined,
          );
        sessionId = null;
        restored = false;
        restoreError = `恢复旧会话失败：${errorWithDetails(error)}`;
      }
      if (!sessionId)
        ({ sessionId } = await this.rpc<{ sessionId: string }>(
          "session/new",
          {
            cwd,
            mcpServers: await this.services(id),
          },
          id,
        ));
      try {
        await this.bind(id, { sessionId });
        if (restored && !fresh)
          this.restored.set(id, this.connections.get(id)!.info.generation);
        if (restoreError) this.recordSessionReset(id, restoreError);
      } catch (error) {
        await this.rpc("session/close", { sessionId }, id).catch(
          () => undefined,
        );
        throw error;
      }
    }).catch((error) => {
      if (error instanceof Problem && error.code === "runner_draining") {
        // The runner refused to start a turn; no attempt or cooldown occurred.
        if (last) this.starts.set(id, last);
        else this.starts.delete(id);
      }
      throw error;
    });
    if (!this.pumping.has(id)) await this.pump(id);
  }
  /** 等真实运行状态空闲后才释放旧实例；切换期间不投递新的回合。 */
  async newSession(id: string, timeoutSeconds = 300) {
    requireAssignment(this.store, id);
    if (this.switching.has(id) || this.connecting.has(id))
      throw new Problem(409, "身份正在接入或切换会话，请稍候");
    const oldFile = this.store.agent(id).session_file;
    const cursor = join(
      process.env.PI_ACP_DIR ?? join(homedir(), ".pi", "pi-acp"),
      "identities",
      `${id}.cursor.json`,
    );
    this.switching.add(id);
    let started = false;
    try {
      await this.discover();
      if (this.discoveryError)
        throw new Problem(503, "无法确认身份是否在其他终端运行，请稍后重试");
      const foreign = this.discovered.find(
        (runtime) =>
          runtime.bound_agent === id &&
          runtime.mode === "tui" &&
          (ownerOf(this.store, id) ? true : alive(runtime.pid)),
      );
      if (foreign)
        throw new Problem(
          409,
          "这个身份正在其他终端运行（atrium run / TUI）；请先在原终端退出，不会抢占会话",
        );
      const connection = this.connections.get(id);
      if (connection && !this.owned(id))
        throw new Problem(
          409,
          "这个身份正在其他终端运行（如 atrium tui / atrium run）；请先在原终端退出，不会抢占会话",
        );
      if (!connection) {
        const pid = this.binding(id).runtime_pid;
        if (ownerOf(this.store, id) ? this.running(id) : pid && alive(pid))
          throw new Problem(
            409,
            "旧 Pi 进程仍在运行，请先在原终端退出；不会抢占会话",
          );
      }
      const deadline = Date.now() + timeoutSeconds * 1000;
      while (this.connections.has(id)) {
        const runtime = this.connections.get(id)!;
        runtime.info = runtimeSchema.parse(
          await this.rpc("_pi/runtime/status", target(runtime.info), id),
        );
        if (!runtime.info.busy) {
          await this.capture(id, runtime.info);
          // A concurrent delivery may have begun during the status request.
          if (!this.pumping.has(id)) break;
        }
        if (Date.now() >= deadline)
          throw new Problem(
            408,
            `等待 ${timeoutSeconds} 秒后当前回合仍未结束；旧会话保持运行，稍后重试`,
            "timeout",
          );
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      // Preserve the pointer as well as the session file if the new start fails.
      const previousCursor = existsSync(cursor) ? readFileSync(cursor) : null;
      const previousBinding = this.binding(id);
      if (this.connections.has(id)) await this.stop(id);
      try {
        await this.start(id, false, true);
      } catch (error) {
        if (previousCursor) {
          const temp = `${cursor}.restore-${randomUUID()}`;
          writeFileSync(temp, previousCursor, { mode: 0o600 });
          renameSync(temp, cursor);
        } else if (existsSync(cursor)) rmSync(cursor);
        this.store.run(
          "UPDATE agents SET session_file=?,acp_session_id=? WHERE id=?",
          previousBinding.session_file,
          previousBinding.acp_session_id,
          id,
        );
        throw new Problem(
          503,
          `新会话启动失败，旧会话文件和指针已保留：${this.redact(id, errorWithDetails(error)).slice(0, 240)}`,
          "new_session_failed",
        );
      }
      this.recordSessionReset(id, "手动开启新会话");
      started = true;
      return {
        old_session_file: oldFile,
        new_session_file: this.store.agent(id).session_file,
      };
    } finally {
      this.switching.delete(id);
      if (started || this.connections.has(id)) await this.pump(id);
    }
  }
  /** Runner leases use machine identity + generation, never a PID on the Web
   * host. Embedded Pi retains the original local gateway PID check. */
  private owned(id: string) {
    const runtime = this.connections.get(id);
    const owner = ownerOf(this.store, id);
    if (owner)
      return (
        this.bridge?.generation(owner.runner_id) === owner.generation &&
        runtime?.info.mode === "rpc" &&
        runtime.info.identityId === id
      );
    return (
      !!this.gateway?.child.pid &&
      runtime?.info.mode === "rpc" &&
      runtime.info.ownerPid === this.gateway.child.pid
    );
  }
  /** 只有自己启动的 Pi 有改模型的通道，还得网关支持这条协议。 */
  private managed(id: string) {
    return this.canSetModel && this.owned(id);
  }
  /** 停掉自己启动的托管实例。会话、身份与待投递消息都保留；被私聊或 @ 时会再起来。 */
  async stop(id: string) {
    if (!this.connections.has(id)) throw new Problem(409, "Agent 没在运行");
    if (!this.owned(id))
      throw new Problem(409, "这个实例不是 Atrium 启动的，请在原终端退出");
    await this.operation(id, async () => {
      await this.rpc("_pi/identity/stop", { identityId: id }, id);
      this.connections.delete(id);
      this.errors.delete(id);
    });
    this.changed();
  }
  private isMigrating(id: string) {
    const deadline = this.migrationLocks.get(id) ?? 0;
    if (deadline > Date.now()) return true;
    this.migrationLocks.delete(id);
    return false;
  }
  finishMigration(id: string) {
    this.migrationLocks.delete(id);
  }
  /** First handoff only: prevent new deliveries, capture final events and
   * stop one embedded identity after its accepted turn has settled. */
  async prepareMigration(id: string): Promise<void> {
    if (ownerOf(this.store, id))
      throw new Problem(409, "身份已归属运行器，无需再次迁移");
    if (
      this.switching.has(id) ||
      this.connecting.has(id) ||
      this.pumping.has(id)
    )
      throw new Problem(409, "身份正在接入或投递，继续等待回合结束");
    this.switching.add(id);
    try {
      const runtime = this.connections.get(id);
      if (!runtime) {
        if (this.running(id))
          throw new Problem(409, "旧 Pi 仍可能运行；先在原终端退出");
        this.migrationLocks.set(id, Date.now() + 15_000);
        return;
      }
      if (!this.owned(id))
        throw new Problem(409, "终端身份不由服务管理；先在原终端退出");
      const info = runtimeSchema.parse(
        await this.rpc("_pi/runtime/status", target(runtime.info), id),
      );
      await this.capture(id, info, 32, true);
      this.reconcileAccepted(id, info);
      if (
        info.busy ||
        this.pumping.has(id) ||
        this.store.pending(id).length ||
        this.turns.current(id) ||
        this.store.one<{ n: number }>(
          "SELECT COUNT(*) AS n FROM deliveries WHERE agent_id=? AND state='accepted'",
          id,
        )!.n
      )
        throw new Problem(409, "回合或投递尚未结算，继续等待");
      await this.stop(id);
      // identity/stop may acknowledge before the local Pi exits. Never hand
      // the lease to a runner while the old writer is still alive.
      const deadline = Date.now() + 10_000;
      while (alive(info.pid) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 100));
      if (alive(info.pid))
        throw new Problem(409, "旧 Pi 尚未退出，暂不交接；请稍后重试此身份");
      // Discovery is refreshed every three seconds, so a just-stopped local
      // runtime could otherwise appear to belong to the newly claimed runner.
      await this.discover();
      this.discovered = this.discovered.filter(
        (item) => item.runtimeId !== info.runtimeId,
      );
      this.migrationLocks.set(id, Date.now() + 15_000);
    } finally {
      this.switching.delete(id);
    }
  }
  /** Claiming a runner is synchronous with respect to Web requests: do not
   * race an in-flight local start before its Pi PID appears in discovery. */
  canBindRunner(id: string): boolean {
    return (
      !this.connecting.has(id) &&
      !this.switching.has(id) &&
      !this.pumping.has(id) &&
      !this.running(id)
    );
  }
  starting(id: string): boolean {
    return this.connecting.has(id);
  }
  /** 删除预览与删除守卫共用实际存活判断；发现列表可能滞后，不能只看名册在线状态。 */
  running(id: string, discovered = this.directory().runtimes): boolean {
    const owner = ownerOf(this.store, id);
    if (owner) {
      // An offline runner can still be executing its Pi turn. Never declare
      // its identity stopped from this Web host's PID table.
      if (this.bridge?.generation(owner.runner_id) !== owner.generation)
        return true;
      return discovered.some(
        (runtime) => runtime.bound_agent === id && runtime.identityId === id,
      );
    }
    const binding = this.binding(id);
    const connected = this.connections.get(id)?.info;
    return !!(
      (binding.runtime_pid && alive(binding.runtime_pid)) ||
      (connected && alive(connected.pid)) ||
      discovered.some(
        (runtime) => runtime.bound_agent === id && alive(runtime.pid),
      )
    );
  }
  /** 撤销最后一个账号前终止活跃身份，不能留下仍在运行的无账号实例。 */
  async stopForUnassignment(id: string) {
    if (ownerOf(this.store, id)) {
      if (this.running(id))
        throw new Problem(409, "运行器可能仍在运行身份；先确认停止");
      return;
    }
    if (this.connections.has(id)) return this.stop(id);
    const pid = this.binding(id).runtime_pid;
    if (pid && alive(pid))
      throw new Problem(409, "身份仍在运行，请先停止后取消分配");
  }
  /** 没能当场生效时，说清是哪一种情况。 */
  private pendingReason(id: string) {
    if (!this.connections.has(id)) return "身份没在运行，下次启动时生效";
    if (!this.canSetModel)
      return "当前安装的 @liuser/pi-atrium 不支持当场切模型，重启这个身份后生效";
    return "这个实例不是 Atrium 启动的，重启它之后生效";
  }
  /** 这个身份可选的模型。只有它在跑才问得到，问到就存下来给离线时用。 */
  private async listModels(id: string): Promise<ModelOption[]> {
    if (!this.managed(id)) return offlineModels(this.store, id);
    try {
      const { models } = z
        .object({
          models: z
            .array(
              z.object({
                id: z.string().min(1).max(200),
                name: z.string().optional(),
              }),
            )
            .max(4000),
        })
        .parse(await this.rpc("_pi/identity/models", { identityId: id }, id));
      const options = [
        ...new Map(
          models.map((model) => [
            model.id,
            { id: model.id, name: model.name?.trim() || model.id },
          ]),
        ).values(),
      ].sort((a, b) => a.id.localeCompare(b.id));
      rememberModels(this.store, id, options);
      return options;
    } catch (error) {
      // 清单取不到不该挡住查看或改动，上一次的缓存照样能用。
      console.error(
        `${this.store.agent(id).name} 的模型清单取回失败：${error}`,
      );
      return offlineModels(this.store, id);
    }
  }
  /** 默认配置复用身份模型来源：先合并已观察清单，空清单时从在线身份取一次。 */
  async modelsForDefaults(): Promise<ModelOption[]> {
    const agents = this.store.agents().filter((agent) => agent.agent_directory);
    const observed = new Map<string, ModelOption>();
    for (const agent of agents)
      for (const model of offlineModels(this.store, agent.id))
        if (
          !observed.has(model.id) ||
          (observed.get(model.id)!.name === model.id && model.name !== model.id)
        )
          observed.set(model.id, model);
    if (observed.size)
      return [...observed.values()].sort((a, b) => a.id.localeCompare(b.id));
    const live = agents.find((agent) => this.managed(agent.id));
    return live ? this.listModels(live.id) : [];
  }
  /** 身份的模型现状：配置里写的、运行中实际在用的、可选清单，以及改动能否当场生效。 */
  async model(id: string): Promise<ModelState> {
    return {
      configured: configuredModel(this.store, id),
      running: this.connections.get(id)?.info.model || null,
      options: await this.listModels(id),
      live: this.managed(id),
    };
  }
  /** 模型是身份的属性：写进身份目录的配置；在运行就顺带让当前实例立即生效。 */
  async setModel(id: string, spec: ModelSpec): Promise<ModelChange> {
    const live = this.managed(id);
    const options = await this.listModels(id);
    const agent = this.store.agent(id);
    const directory = agent.agent_directory;
    const previous =
      live && directory ? snapshotIdentityModel(directory) : null;
    const { wanted, configured } = configureModel(
      this.store,
      id,
      spec,
      options,
    );
    let applied: string | null = null;
    if (live)
      try {
        ({ model: applied } = await this.rpc<{ model: string }>(
          "_pi/identity/model",
          {
            identityId: id,
            model: wanted,
            ...(spec.thinking ? { thinking: spec.thinking } : {}),
          },
          id,
        ));
      } catch (error) {
        if (directory && previous) restoreIdentityModel(directory, previous);
        const detail = String(error);
        // 两份目录对不上时 pi 会以原生报错拒绝思考强度：转成中文回执加修正。
        const fallback = liveThinkingProblem(detail, wanted, agent);
        if (fallback) throw fallback;
        const reason = detail.includes("Model not found:")
          ? `运行中的 Pi 找不到 ${wanted}，请检查模型配置`
          : `运行中的实例没能当场切换：${detail}`;
        throw new Problem(409, `${reason}。模型配置已恢复原值。`);
      }
    this.changed();
    return {
      configured,
      running: applied ?? this.connections.get(id)?.info.model ?? null,
      options,
      live,
      notes: [
        ...(options.length
          ? []
          : [
              "没取到过这个身份的模型清单，只校验了写法，没核对模型是否真的存在",
            ]),
        ...(live ? [] : [this.pendingReason(id)]),
      ],
    };
  }
  pump(id: string, direct = false): Promise<void> {
    if (this.stopped || this.draining || this.isMigrating(id))
      return Promise.resolve();
    // A lost response is not an acknowledged delivery. A later successful
    // turn or direct wake must not silently lift this gate.
    if (this.store.uncertainDelivery(id) && !this.manuallyRetrying.has(id))
      return Promise.resolve();
    if (this.store.failure(id) && !direct) {
      if (this.discoveredOnce && !this.running(id, this.discovered))
        this.reconcileAccepted(id, null);
      return Promise.resolve();
    }
    const existing = this.pumping.get(id);
    if (existing) return existing;
    const incident = this.store.incident(id);
    if (!this.explicitlyRetrying.has(id) && !this.manuallyRetrying.has(id)) {
      if (needsUserAttempt(incident)) {
        const userMessage = this.store.userAttemptDue(id);
        if (!userMessage || !this.store.claimUserAttempt(id, userMessage))
          return Promise.resolve();
        this.userAttempt.set(id, userMessage);
        direct = true;
      } else if (direct && incident?.category === "transient") {
        // This new user message is being attempted via the normal pending path.
        // Do not replay it after the scheduled attempts are exhausted.
        const userMessage = this.store.userAttemptDue(id);
        if (userMessage) this.store.claimUserAttempt(id, userMessage);
      }
    }
    const promise = this.doPump(id, direct).finally(() => {
      this.userAttempt.delete(id);
      this.pumping.delete(id);
    });
    this.pumping.set(id, promise);
    return promise;
  }
  private async doPump(id: string, direct: boolean): Promise<void> {
    if (!hasAssignment(this.store, id)) {
      if (this.discoveredOnce && !this.running(id, this.discovered))
        this.reconcileAccepted(id, null);
      if (
        this.store.pending(id).length &&
        this.store.failure(id)?.text !== UNASSIGNED
      ) {
        this.store.setFailure(id, UNASSIGNED);
        this.changed();
      }
      return;
    }
    let operationFailed = false;
    const incident = this.store.incident(id);
    const singleAttempt =
      !this.manuallyRetrying.has(id) &&
      !this.explicitlyRetrying.has(id) &&
      needsUserAttempt(incident);
    try {
      if (this.connecting.has(id) || this.switching.has(id)) return;
      let runtime = this.connections.get(id);
      // A TUI may exit and immediately restart under the same identity. Discovery
      // knows the new runtime before a status poll of the old one necessarily fails.
      const priorRuntimeId = runtime?.info.runtimeId;
      const currentBinding = this.binding(id);
      if (
        priorRuntimeId &&
        currentBinding.runtime_id !== priorRuntimeId &&
        this.discovered.some(
          (entry) =>
            entry.bound_agent === id &&
            entry.runtimeId === currentBinding.runtime_id,
        )
      ) {
        this.connections.delete(id);
        runtime = undefined;
      }
      if (!runtime) {
        const binding = this.binding(id);
        const owner = ownerOf(this.store, id);
        // The Web may reconnect before its first runner discovery. A manual
        // retry must ask the owner about the old runtime before deciding to
        // boot a replacement (which would collide with the live Pi lock).
        if (owner && binding.runtime_id) {
          if (direct || !this.discoveredOnce) await this.discover();
          if (this.discoveryError) return;
        }
        const discoveredOwner = this.discovered.some(
          (item) =>
            item.runtimeId === binding.runtime_id && item.bound_agent === id,
        );
        if (owner && binding.runtime_id && !discoveredOwner) {
          // Absence from discovery is not proof that a remotely owned Pi has
          // exited. Keep the unknown delivery and its retry entry intact.
          this.reconcileAccepted(id, null);
          return;
        }
        if (
          binding.runtime_id &&
          (owner
            ? this.bridge?.generation(owner.runner_id) === owner.generation &&
              discoveredOwner
            : !!binding.runtime_pid && alive(binding.runtime_pid))
        ) {
          await this.operation(
            id,
            () => this.bind(id, { runtimeId: binding.runtime_id! }),
            direct || this.store.pending(id).length > 0,
          ).catch((error) => {
            operationFailed = true;
            throw error;
          });
          runtime = this.connections.get(id);
        } else {
          if (wakesOffline(this.store.pending(id)))
            await this.start(id, !direct).catch((error) => {
              operationFailed = true;
              throw error;
            });
          runtime = this.connections.get(id);
        }
      }
      if (!runtime) {
        if (this.discoveredOnce && !this.running(id, this.discovered))
          this.reconcileAccepted(id, null);
        return;
      }
      try {
        runtime.info = runtimeSchema.parse(
          await this.rpc("_pi/runtime/status", target(runtime.info), id),
        );
        this.assertOpen();
        this.remember(id, runtime.info);
      } catch (error) {
        await this.rpc("_pi/runtime/detach", target(runtime.info), id).catch(
          () => undefined,
        );
        this.connections.delete(id);
        throw error;
      }
      await this.capture(id, runtime.info);
      this.reconcileAccepted(id, runtime.info);
      const recovery = this.recovery.get(id);
      if (recovery) {
        await this.recover(id, recovery);
        return this.doPump(id, direct);
      }
      let triggeredTurn = false;
      // 纯告知不单独成行，等下面真正要走的投递搭车；pending() 里已经不含它。
      for (const pending of executable(this.store.pending(id))) {
        if (
          singleAttempt &&
          pending.through_message !== this.userAttempt.get(id)
        )
          continue;
        // A successful turn can clear the identity failure while its delivery
        // remains uncertain. Only an explicit retry may ask Pi about this id.
        if (
          pending.error?.startsWith("投递结果未知") &&
          !this.manuallyRetrying.has(id)
        )
          break;
        if (this.store.failure(id) && !direct) break;
        if (pending.kind === "summary" && (runtime.info.busy || triggeredTurn))
          continue;
        // 提醒在忙时排队、空闲才送，期间可能已经读完：送出前按当时的消息箱重写，清空了就撤回。
        const reminder =
          pending.kind === "summary" ? this.store.reminder(id) : pending.text;
        if (reminder === null) {
          this.store.withdrawReminder(pending.id);
          continue;
        }
        // 排队的纯告知搭这一趟车：合并进同一条正文，对方不必逐条开回合。
        const notices = this.store.notices(id);
        const noticeIds = notices.map((item) => item.id);
        const text = mergeNotices(
          reminder,
          notices.map((item) => item.text),
        );
        try {
          const images = pending.through_message
            ? this.store
                .attachmentsFor(pending.through_message)
                .filter((item) => item.kind === "image")
                .map((item) => {
                  const { bytes } = this.store.readBytes(item.id);
                  return {
                    type: "image" as const,
                    mimeType: item.mime,
                    data: bytes.toString("base64"),
                  };
                })
            : [];
          const deliveryStart = Date.now();
          const result = await this.rpc<{
            accepted: boolean;
            duplicate?: boolean;
          }>(
            "_pi/runtime/deliver",
            {
              ...target(runtime.info),
              id: pending.id,
              source: "Atrium",
              text,
              delivery: pending.kind === "direct" ? "steer" : "followUp",
              ...(images.length ? { images } : {}),
            },
            id,
          );
          this.assertOpen();
          if (!result.accepted) throw new Error("Pi 未确认接收");
          if (result.duplicate) {
            if (pending.error?.startsWith("投递结果未知")) {
              // Duplicate proves Pi received the original id, not that its
              // turn succeeded. Check persisted failure after trace catch-up:
              // the Web may have restarted and lost its lastTurn cache.
              runtime.info = runtimeSchema.parse(
                await this.rpc("_pi/runtime/status", target(runtime.info), id),
              );
              this.assertOpen();
              this.remember(id, runtime.info);
              await this.capture(id, runtime.info);
              const settled =
                !runtime.info.busy &&
                !this.traceErrors.has(id) &&
                !this.traceLag.has(id);
              const failure = this.store.failure(id);
              if (
                settled &&
                failure &&
                !failure.text.startsWith("投递结果未知")
              ) {
                // A failed original turn needs a fresh id and the replay note,
                // just like an acknowledged failed turn. Only an explicit retry
                // reaches this path; never duplicate an unknown automatically.
                this.store.rekeyPending(pending.id);
                this.changed();
                return this.doPump(id, direct);
              }
              // Pi 收到的仍是原来那一次的正文，这一趟合并进来的告知并没有交出去：
              // 不删任何告知，宁可下一趟重复附带，也不丢。
              this.store.accepted(pending.id, !settled, []);
              if (settled) {
                this.store.completeDelivery(pending.id);
                // Duplicate alone is not success; settled additionally proves the
                // old run_end completed with no trace error, even after restart.
                if (!this.store.uncertainDelivery(id))
                  this.store.clearFailure(id, true);
              }
              // Busy or incomplete trace: retain the failure and retry entry.
            } else {
              // An unrelated earlier id has no proof of completion.
              this.store.rekeyPending(pending.id);
            }
            this.changed();
            break;
          }
          this.store.accepted(pending.id, false, noticeIds);
          if (pending.kind === "direct") triggeredTurn = true;
          // A turn may fail before deliver returns. Observe its end only after
          // accepting, so the failed delivery cannot be stranded as accepted.
          await this.capture(id, runtime.info);
          const recovery = this.recovery.get(id);
          if (recovery) {
            await this.recover(id, recovery);
            return this.doPump(id, direct);
          }
          const turn = this.lastTurn.get(id);
          if (
            turn?.generation === runtime.info.generation &&
            turn.deliveryAt !== null &&
            turn.deliveryAt >= deliveryStart &&
            turn.at >= turn.deliveryAt
          ) {
            if (turn.successful) this.store.completeDelivery(pending.id);
            else this.store.finishTurn(id, false, turn.deliveryAt, true);
          }
          this.changed();
          // A broken old session may fail every queued message. A user message
          // permits one turn, not a replay of all older pending deliveries.
          if (singleAttempt || (turn && !turn.successful)) break;
        } catch (error) {
          if (
            this.restored.get(id) === runtime.info.generation &&
            this.sessionError(error)
          ) {
            try {
              await this.recover(
                id,
                `恢复后首轮不可用：${errorWithDetails(error)}`,
              );
              return this.doPump(id, direct);
            } catch (recoveryError) {
              error = recoveryError;
            }
          }
          if (
            error instanceof Problem &&
            (error.code === "runner_offline" ||
              error.code === "runner_draining")
          ) {
            this.store.releaseUnstartedRetry(id, this.retryOwner);
            break;
          }
          if (
            error instanceof Problem &&
            error.code === "runner_outcome_unknown"
          ) {
            const warning =
              "投递结果未知：运行器连接中断；先核对轨迹和消息箱，再手动重试，系统不会自动重复投递";
            this.store.deliveryError(pending.id, warning);
            this.store.setFailure(id, warning);
            this.changed();
            break;
          }
          if (!this.stopped) {
            const message = this.redact(id, errorWithDetails(error));
            this.store.deliveryError(pending.id, message);
            this.store.setFailure(
              id,
              message,
              Date.now(),
              "delivery",
              undefined,
              error instanceof Problem ? error.code : undefined,
            );
            this.store.finishTurn(id, false);
            this.changed();
          }
          break;
        }
      }
    } catch (error) {
      if (
        error instanceof Problem &&
        (error.code === "runner_offline" ||
          error.code === "runner_draining" ||
          error.code === "runner_outcome_unknown")
      ) {
        if (error.code !== "runner_outcome_unknown")
          this.store.releaseUnstartedRetry(id, this.retryOwner);
        return;
      }
      if (!this.stopped) {
        const message = this.redact(id, errorWithDetails(error));
        this.errors.set(id, message);
        // A TUI may replace its session while an idle status poll is in flight.
        // Only a failed wake/delivery is a failed turn, not that transient poll.
        if (!operationFailed && this.store.pending(id).length) {
          this.store.setFailure(
            id,
            message,
            Date.now(),
            "delivery",
            undefined,
            error instanceof Problem ? error.code : undefined,
          );
          this.store.finishTurn(id, false);
        }
        this.changed();
      }
    }
  }
  /** Unknown outcomes retry only after the old process is gone or a settled idle status. */
  private reconcileAccepted(id: string, info: RuntimeInfo | null) {
    const row = this.store.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM deliveries WHERE agent_id=? AND state='accepted' AND (error IS NULL OR error NOT LIKE '投递结果未知%')",
      id,
    );
    if (!row?.n) {
      this.idleAccepted.delete(id);
      return;
    }
    const turn = this.turns.current(id);
    const oldGeneration =
      turn &&
      info &&
      (turn.runtime_id !== info.runtimeId ||
        turn.generation !== info.generation);
    // A different instance cannot finish an old turn. Otherwise an idle status
    // may precede a delayed event: wait for a quiet interval after catch-up.
    if (info && !oldGeneration) {
      if (info.busy || this.traceErrors.has(id) || this.traceLag.has(id)) {
        this.idleAccepted.delete(id);
        return;
      }
      const idle = this.idleAccepted.get(id);
      if (
        !idle ||
        idle.runtime !== info.runtimeId ||
        idle.generation !== info.generation
      ) {
        this.idleAccepted.set(id, {
          runtime: info.runtimeId,
          generation: info.generation,
          since: Date.now(),
        });
        return;
      }
      if (Date.now() - idle.since < 10_000) return;
    }
    this.idleAccepted.delete(id);
    this.turns.clear(id);
    this.lastTurn.delete(id);
    this.store.finishTurn(id, false);
    this.changed();
  }
  private async refreshStatus(
    id: string,
    entry: { connection: ClientConnection | null; info: RuntimeInfo },
  ): Promise<RuntimeInfo> {
    const previous = entry.info;
    try {
      const current = runtimeSchema.parse(
        await this.rpc("_pi/runtime/status", target(previous), id),
      );
      this.assertOpen();
      if (
        this.connections.get(id) !== entry ||
        current.runtimeId !== previous.runtimeId ||
        current.generation !== previous.generation
      )
        throw new Error(`身份 ${id} 的运行实例已更换`);
      entry.info = current;
      this.remember(id, current);
      this.store.recordStatusCheck(id, true);
      return current;
    } catch (error) {
      if (!this.stopped && this.connections.get(id) === entry)
        this.store.recordStatusCheck(id, false);
      throw error;
    }
  }
  private async capture(
    id: string,
    info: RuntimeInfo,
    maxPages = 2,
    strict = false,
  ) {
    const before = this.traceErrors.get(id);
    try {
      // Regular ticks are bounded; shutdown must consume all remaining pages.
      for (let page = 0; page < maxPages; page++) {
        let settled = false;
        const events = runtimeEvents.parse(
          await this.rpc(
            "_pi/runtime/events",
            {
              ...target(info),
              after: this.traces.cursor(id, info.runtimeId, info.generation),
              limit: 50,
            },
            id,
          ),
        );
        const current = this.connections.get(id)?.info;
        if (
          this.stopped ||
          current?.runtimeId !== info.runtimeId ||
          current?.generation !== info.generation
        ) {
          if (strict) throw new Error(`身份 ${id} 的运行实例在轨迹同步时变化`);
          return;
        }
        if (
          events.runtimeId !== info.runtimeId ||
          events.generation !== info.generation ||
          events.sessionId !== info.sessionId
        )
          throw new Error("轨迹来自其他运行代际");
        if (
          this.traces.ingest(
            id,
            events,
            (event, traceId) => {
              // This callback runs before the same transaction advances trace_cursors.
              const turn = this.turns.ingest(
                id,
                info.runtimeId,
                info.generation,
                event,
              );
              if (event.kind === "run_start") {
                if (
                  this.store.failure(id) &&
                  !this.store.failure(id)?.text.startsWith("投递结果未知") &&
                  !this.store
                    .failure(id)
                    ?.text.includes("模型认证失败，请更换 API Key")
                ) {
                  // Keep the incident and retry count until a verified run_end.
                  this.errors.delete(id);
                }
              } else if (event.kind === "run_end") {
                settled = true;
                // An end without a persisted start cannot prove completion.
                if (turn)
                  this.lastTurn.set(id, {
                    generation: info.generation,
                    at: event.at,
                    deliveryAt: turn.delivery_at,
                    successful: !turn.failure,
                  });
                if (this.restored.get(id) === info.generation) {
                  this.restored.delete(id);
                  if (
                    turn?.delivery_at != null &&
                    turn.failure &&
                    this.sessionError(turn.failure)
                  )
                    this.recovery.set(id, `恢复后首轮不可用：${turn.failure}`);
                }
                if (turn?.failure) {
                  this.authFailure(id, turn.failure);
                  if (!this.recovery.has(id))
                    this.store.setFailure(
                      id,
                      /\b(401|403)\b|unauthoriz|forbidden|invalid.api.key|invalid_key/i.test(
                        turn.failure,
                      )
                        ? "模型认证失败，请更换 API Key"
                        : this.redact(id, turn.failure),
                      event.at,
                      "provider",
                      `${info.runtimeId}:${info.generation}:${event.seq}`,
                    );
                }
                if (turn && !turn.failure) {
                  if (turn.delivery_at !== null && !this.recovery.has(id))
                    this.store.finishTurn(id, true, turn.delivery_at);
                  this.errors.delete(id);
                }
              }
              // 第一条正常模型输出清掉旧故障，与失败判定共用一处规则。
              settleFailure(this.store, id, event, traceId);
            },
            () => this.turns.clear(id),
          )
        )
          this.changed();
        if (settled) {
          // The trace closes the run, but cannot update Pi's live busy flag.
          // A steer earlier in the turn may have cached busy=true; refresh it
          // here so listing, idle checks and later deliveries see the settled state.
          const entry = this.connections.get(id);
          if (
            entry &&
            entry.info.runtimeId === info.runtimeId &&
            entry.info.generation === info.generation
          ) {
            try {
              await this.refreshStatus(id, entry);
            } catch (error) {
              if (strict) throw error;
              console.warn(`无法在回合结束时核对 ${id} 的运行状态：`, error);
            }
          }
        }
        if (!events.hasMore) {
          this.traceLag.delete(id);
          break;
        }
        if (page === maxPages - 1) this.traceLag.add(id);
        if (strict && page === maxPages - 1)
          throw new Error(`身份 ${id} 的轨迹未在 ${maxPages} 页内同步完毕`);
      }
      this.traceErrors.delete(id);
    } catch (error) {
      this.traceLag.add(id);
      if (!this.stopped)
        this.traceErrors.set(
          id,
          "暂时无法读取实时轨迹；请确认此 Pi 已加载支持轨迹的 pi-atrium 扩展。已有记录仍可查看。",
        );
      if (strict) throw error;
    }
    if (!this.stopped && before !== this.traceErrors.get(id)) this.changed();
  }
  async retry(id: string) {
    this.store.agent(id);
    const runtime = this.connections.get(id);
    if (runtime) await this.capture(id, runtime.info);
    const uncertain = this.store.uncertainDelivery(id);
    if (!this.store.failure(id) && !uncertain)
      throw new Problem(409, "Agent 当前没有运行错误");
    // A steer during the failed turn may have cached busy=true. Read Pi's
    // current state before rejecting a manual retry; pump is failure-gated.
    if (runtime && !uncertain && (await this.refreshStatus(id, runtime)).busy)
      throw new Problem(409, "Agent 当前正在处理，请等待这一轮结束");
    if (uncertain) {
      if (this.pumping.has(id)) await this.pumping.get(id);
      this.store.retryUncertain(uncertain.id);
      this.manuallyRetrying.add(id);
      try {
        await this.pump(id, true);
      } finally {
        this.manuallyRetrying.delete(id);
      }
      return;
    }
    this.store.finishTurn(id, false);
    this.explicitlyRetrying.add(id);
    try {
      await this.pump(
        id,
        agentTransition(this.store.failure(id), { kind: "retry" }).wake,
      );
    } finally {
      this.explicitlyRetrying.delete(id);
    }
  }
  activeAgentIds(): string[] {
    return [...this.connections.keys()].filter(
      (id) =>
        !ownerOf(this.store, id) &&
        (this.pumping.has(id) || this.connections.get(id)?.info.busy),
    );
  }
  async prepareShutdown(
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string[]> {
    if (this.draining) throw new Error("服务正在排空任务");
    const agents = new Set(this.activeAgentIds());
    this.draining = true;
    const deadline = Date.now() + timeoutMs;
    let busyIds: string[] = [];
    try {
      // Remote rounds belong to the independent runner; Web restarts must not
      // wait for or restart them. The next Web process reattaches and captures.
      const local = () =>
        [...this.connections].filter(([id]) => !ownerOf(this.store, id));
      while (this.ticking && Date.now() < deadline) {
        if (signal?.aborted)
          throw new Error("排空中止：发起方已断开，服务恢复运行");
        await new Promise((r) => setTimeout(r, 100));
      }
      while (Date.now() < deadline) {
        if (signal?.aborted)
          throw new Error("排空中止：发起方已断开，服务恢复运行");
        // The discovery tick is paused while draining. Refresh busy state from
        // each running Pi; a stale snapshot would make every busy restart time out.
        const statuses = await Promise.all(
          local().map(async ([id, entry]) => {
            const current = runtimeSchema.parse(
              await this.rpc("_pi/runtime/status", target(entry.info), id),
            );
            entry.info = current;
            if (current.busy) agents.add(id);
            return { id, busy: current.busy };
          }),
        );
        busyIds = [
          ...new Set([
            ...statuses
              .filter((status) => status.busy)
              .map((status) => status.id),
            ...[...this.pumping.keys()].filter(
              (id) => !ownerOf(this.store, id),
            ),
            ...[...this.connecting.keys()].filter(
              (id) => !ownerOf(this.store, id),
            ),
          ]),
        ];
        if (busyIds.length === 0) {
          // Pi can report idle just before the final events become visible.
          // Flush first, then require the observed run_start to have run_end.
          await Promise.all(
            local().map(([id, entry]) =>
              this.capture(id, entry.info, 100, true),
            ),
          );
          busyIds = local()
            .map(([id]) => id)
            .filter((id) => this.turns.current(id) != null);
          for (const id of busyIds) agents.add(id);
          if (busyIds.length === 0) return [...agents];
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      const names = busyIds.map((id) => {
        const agent = this.store.agent(id);
        return `${agent.name}（${agent.ref}）`;
      });
      throw new Error(
        `Agent 回合未在 ${timeoutMs / 1000} 秒内完成；仍在工作：${names.join("、") || "状态未确认"}。旧服务继续运行；待回合结束后重新运行 atrium restart，或使用 --agent-timeout <毫秒> 延长等待`,
      );
    } catch (error) {
      this.draining = false;
      throw error;
    }
  }
  health(): { available: boolean; error: string | null } {
    const available =
      !this.stopped && !this.draining && this.gateway !== undefined;
    return {
      available,
      error: this.discoveryError ?? (available ? null : "网关未就绪"),
    };
  }
  private async tick() {
    if (this.stopped || this.draining || this.ticking) return;
    this.ticking = true;
    try {
      await this.discover();
      if (this.stopped || this.draining) return;
      for (const agentId of [...this.needsReload]) {
        const entry = this.connections.get(agentId);
        if (entry && !entry.info.busy && entry.info.mode === "rpc") {
          this.needsReload.delete(agentId);
          try {
            await this.stop(agentId);
            await this.start(agentId);
          } catch (err) {
            console.warn(`自动重载 Agent ${agentId} 失败：`, err);
          }
        }
      }
      if (this.store.schedule().length) this.changed();
      await Promise.all(
        this.store.agents().map(async (agent) => {
          const before = JSON.stringify(this.connections.get(agent.id)?.info);
          if (this.store.failure(agent.id) && this.connections.get(agent.id))
            await this.capture(agent.id, this.connections.get(agent.id)!.info);
          this.store.guardOrphanRetry(agent.id, this.retryOwner);
          const failure = this.store.failure(agent.id);
          const incident = failure ? this.store.incident(agent.id) : null;
          const userDue =
            needsUserAttempt(incident) && !!this.store.userAttemptDue(agent.id);
          const peerDue =
            failure !== null &&
            incident?.category === "transient" &&
            !needsUserAttempt(incident) &&
            this.store
              .pending(agent.id)
              .some(
                (delivery) =>
                  delivery.kind === "direct" &&
                  delivery.created_at > failure.at,
              );
          const retry =
            !userDue && !peerDue
              ? this.store.retryStatus(agent.id)?.retry
              : null;
          const ready =
            retry?.state === "waiting" &&
            retry.next_at !== null &&
            retry.next_at <= Date.now() &&
            !this.connecting.has(agent.id) &&
            !this.pumping.has(agent.id) &&
            !this.switching.has(agent.id) &&
            !this.isMigrating(agent.id) &&
            (await this.retryRunnerReady(agent.id));
          const entry = this.connections.get(agent.id);
          let idle = !entry?.info.busy;
          if (ready && entry) {
            try {
              idle = !(await this.refreshStatus(agent.id, entry)).busy;
            } catch (error) {
              // No fresh status, no retry claim. Three consecutive failures
              // become a terminal incident rather than an endless waiting badge.
              console.warn(`无法核对 ${agent.name} 的运行状态：`, error);
              idle = false;
            }
          }
          const autoDue =
            ready &&
            idle &&
            this.store.claimRetry(agent.id, Date.now(), this.retryOwner);
          try {
            await this.pump(agent.id, userDue || peerDue || autoDue);
          } finally {
            if (autoDue)
              this.store.blockUnstartedRetry(agent.id, this.retryOwner);
          }
          if (notifyTerminal(this.store, agent.id)) this.changed();
          if (before !== JSON.stringify(this.connections.get(agent.id)?.info))
            this.changed();
        }),
      );
    } finally {
      this.ticking = false;
    }
  }
  private stopGateway(gateway: Gateway): Promise<void> {
    if (gateway.stopping) return gateway.stopping;
    gateway.stopping = (async () => {
      gateway.connection.close();
      gateway.child.stdin.end();
      const terminate = setTimeout(
        () => gateway.child.kill("SIGTERM"),
        14000,
      ).unref();
      const force = setTimeout(
        () => gateway.child.kill("SIGKILL"),
        17000,
      ).unref();
      try {
        await gateway.closed;
      } finally {
        clearTimeout(terminate);
        clearTimeout(force);
      }
    })();
    return gateway.stopping;
  }
  async close() {
    this.stopped = true;
    clearInterval(this.interval);
    this.bridge?.close();
    await Promise.allSettled([
      ...this.pumping.values(),
      ...this.connecting.values(),
      ...(this.opening ? [this.opening] : []),
      ...(this.scanning ? [this.scanning] : []),
      ...[...this.gateways].map((gateway) => this.stopGateway(gateway)),
    ]);
  }
}
