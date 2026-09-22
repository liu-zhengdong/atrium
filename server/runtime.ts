import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  existsSync,
  renameSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";
import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientConnection,
} from "@agentclientprotocol/sdk";
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
} from "../shared/model.ts";
import { Store, Problem } from "./store.ts";
import { wakesOffline } from "./delivery.ts";
import { atriumGuide } from "./mcp.ts";
import {
  prepareProfile,
  readIdentityModel,
  syncIdentityProfile,
} from "./profile.ts";
import {
  cachedModels,
  configuredModel,
  configureModel,
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
import { runtimeEvents } from "../shared/trace.ts";

const require = createRequire(import.meta.url);
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
  stopping?: Promise<void>;
};
const target = (r: RuntimeInfo) => ({
  runtimeId: r.runtimeId,
  generation: r.generation,
  sessionId: r.sessionId,
});
const guideId = (agent: string, session: string) => {
  const h = createHash("sha256")
    .update(`${agent}:${session}:guide:v2`)
    .digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

/** Business-side ACP client. Pi processes, IPC discovery and native context belong to pi-atrium. */
export class Runtimes {
  readonly connections = new Map<
    string,
    { connection: ClientConnection; info: RuntimeInfo }
  >();
  readonly errors = new Map<string, string>();
  readonly traceErrors = new Map<string, string>();
  readonly traces: TraceStore;
  private gateway?: Gateway;
  private gateways = new Set<Gateway>();
  private opening?: Promise<Gateway>;
  private connecting = new Map<string, Promise<void>>();
  private bindingOwners = new Map<string, string>();
  private pumping = new Map<string, Promise<void>>();
  private starts = new Map<string, { at: number; failures: number }>();
  private stopped = false;
  private discovered: LiveRuntime[] = [];
  private discoveryError: string | null = null;
  private discoveredOnce = false;
  /** 当前网关支不支持当场切模型；不支持也照常跑，只是改动要等重启。 */
  private canSetModel = false;
  private scanning?: Promise<void>;
  private ticking = false;
  private interval: NodeJS.Timeout;
  constructor(
    private store: Store,
    private data: string,
    private changed: () => void,
    private baseUrl: () => string,
    private piHome: string | undefined,
    private desktops: string,
  ) {
    this.traces = new TraceStore(store);
    mkdirSync(join(data, "credentials"), { recursive: true, mode: 0o700 });
    this.interval = setInterval(() => {
      void this.tick();
    }, 3000).unref();
    void this.discover();
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
          ...process.env,
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
      const gateway: Gateway = { connection, child, closed };
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
        this.canSetModel = !!result._meta["pi-acp/identity/model/v1"];
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
  ): Promise<T> {
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
    await this.operation(id, async () => {
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
        const agent = this.store.agent(id),
          binding = this.binding(id);
        if (confirm !== agent.ref)
          throw new Problem(400, "删除确认与 Agent 不一致");
        const connected = this.connections.get(id)?.info;
        if (
          (binding.runtime_pid && alive(binding.runtime_pid)) ||
          (connected && alive(connected.pid)) ||
          this.directory().runtimes.some((r) => r.bound_agent === id)
        )
          throw new Problem(409, "Agent 仍在运行，请先正常停止后再删除");
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
    });
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
    const { runtimes } = z
      .object({ runtimes: z.array(liveRuntimeSchema).max(256) })
      .parse(value);
    // Canonicalize during discovery, never on the overview's hot read path.
    return this.withOwners(
      runtimes.map((r) => {
        let cwd = r.cwd;
        try {
          cwd = realpathSync(cwd);
        } catch {
          /* Preserve display metadata for inaccessible directories. */
        }
        return { ...r, cwd };
      }),
    );
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
    if (runtime.bound_agent) return this.store.agent(runtime.bound_agent);
    throw new Problem(
      409,
      "这是临时 Pi；请新建长期身份后使用具名入口启动，不会自动创建账号",
    );
  }
  private services(id: string) {
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
        url: `${this.baseUrl()}/mcp/${id}`,
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
    try {
      info = runtimeSchema.parse(
        await this.rpc("_pi/runtime/attach", selector),
      );
      const profile = this.store.agent(id);
      if (profile.agent_directory && info.identityId !== id)
        throw new Problem(409, "运行实例不属于这个长期身份");
      if (realpathSync(info.cwd) !== realpathSync(profile.cwd))
        throw new Problem(409, "Pi 工作目录与 Agent 配置不一致");
      if (
        this.store.one(
          "SELECT id FROM agents WHERE runtime_id=? AND id<>?",
          info.runtimeId,
          id,
        )
      )
        throw new Problem(409, "这个 Pi 已绑定另一个 Agent");
      await this.rpc("_pi/runtime/mcp", {
        ...target(info),
        mcpServers: this.services(id),
      });
      await this.rpc("_pi/runtime/deliver", {
        ...target(info),
        id: guideId(id, info.sessionId),
        source: "Atrium 接入说明",
        text: atriumGuide,
        delivery: "steer",
        triggerTurn: false,
      });
      this.assertOpen();
      this.remember(id, info);
      this.connections.set(id, { connection: this.gateway!.connection, info });
      this.errors.delete(id);
      this.changed();
    } catch (error) {
      if (info)
        await this.rpc("_pi/runtime/detach", target(info)).catch(
          () => undefined,
        );
      throw error;
    } finally {
      if (selected && this.bindingOwners.get(selected) === id)
        this.bindingOwners.delete(selected);
    }
  }
  private async operation(id: string, run: () => Promise<void>) {
    this.assertOpen();
    if (this.connecting.has(id))
      throw new Problem(409, "Agent 正在接入，请稍候");
    const promise = run().catch((error) => {
      if (!this.stopped) {
        this.errors.set(id, String(error));
        this.changed();
      }
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
    this.store.agent(id);
    if (this.connections.has(id)) throw new Problem(409, "Agent 已连接");
    await this.operation(id, () => this.bind(id, { runtimeId }));
    await this.pump(id);
  }
  async promote(id: string, template?: string) {
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
  async start(id: string, automatic = false) {
    const binding = this.binding(id);
    if (this.connections.has(id)) throw new Problem(409, "Agent 已在运行");
    if (binding.runtime_pid && alive(binding.runtime_pid))
      throw new Problem(409, "原 Pi 进程仍存在，等待重连；不会另开同一会话");
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
        // A profile left on the old layout costs the Agent a rule, not its session.
        for (const notice of syncIdentityProfile(current.agent_directory))
          console.error(`${current.name} 的${notice}`);
        const configured = readIdentityModel(current.agent_directory);
        const { runtimeId } = await this.rpc<{ runtimeId: string }>(
          "_pi/identity/start",
          {
            identityId: id,
            agentDirectory: current.agent_directory,
            cwd,
            ...(current.session_file
              ? { sessionFile: current.session_file }
              : {}),
            // 恢复的会话自带模型记录，会盖过配置默认值；只有启动参数压得住它。
            ...(configured ? { model: formatModelSpec(configured) } : {}),
          },
        );
        try {
          await this.bind(id, { runtimeId });
        } catch (error) {
          await this.rpc("_pi/identity/stop", { identityId: id }).catch(
            () => undefined,
          );
          throw error;
        }
        return;
      }
      let sessionId = binding.acp_session_id;
      if (!sessionId && binding.session_file) {
        ({ sessionId } = await this.rpc<{ sessionId: string }>(
          "_pi/session/import",
          { cwd, sessionFile: binding.session_file },
        ));
        this.store.run(
          "UPDATE agents SET acp_session_id=? WHERE id=?",
          sessionId,
          id,
        );
      }
      if (sessionId)
        await this.rpc("session/load", {
          sessionId,
          cwd,
          mcpServers: this.services(id),
        });
      else
        ({ sessionId } = await this.rpc<{ sessionId: string }>("session/new", {
          cwd,
          mcpServers: this.services(id),
        }));
      try {
        await this.bind(id, { sessionId });
      } catch (error) {
        await this.rpc("session/close", { sessionId }).catch(() => undefined);
        throw error;
      }
    });
    if (!this.pumping.has(id)) await this.pump(id);
  }
  /** 本进程这条网关自己启动的 Pi；别处发现、由 TUI 或旧网关拉起的实例不归它管。 */
  private owned(id: string) {
    const runtime = this.connections.get(id);
    return (
      runtime?.info.mode === "rpc" &&
      runtime.info.ownerPid === this.gateway?.child.pid
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
      await this.rpc("_pi/identity/stop", { identityId: id });
      this.connections.delete(id);
      this.errors.delete(id);
    });
    this.changed();
  }
  /** 没能当场生效时，说清是哪一种情况。 */
  private pendingReason(id: string) {
    if (!this.connections.has(id)) return "身份没在运行，下次启动时生效";
    if (!this.canSetModel)
      return "当前安装的 @liuser/pi-atrium 不支持当场切模型，重启这个身份后生效";
    return "这个实例不是 Atrium 启动的，重启它之后生效";
  }
  /** 这个身份可选的模型。只有它在跑才问得到，问到就存下来给离线时用。 */
  private async listModels(id: string): Promise<string[]> {
    if (!this.managed(id)) return cachedModels(this.store, id);
    try {
      const { models } = z
        .object({
          models: z
            .array(z.object({ id: z.string().min(1).max(200) }))
            .max(4000),
        })
        .parse(await this.rpc("_pi/identity/models", { identityId: id }));
      const options = [...new Set(models.map((model) => model.id))].sort();
      rememberModels(this.store, id, options);
      return options;
    } catch (error) {
      // 清单取不到不该挡住查看或改动，上一次的缓存照样能用。
      console.error(
        `${this.store.agent(id).name} 的模型清单取回失败：${error}`,
      );
      return cachedModels(this.store, id);
    }
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
        ));
      } catch (error) {
        throw new Problem(
          409,
          `已写入 ${configured}，但运行中的实例没能当场切换：${error}。重启这个身份即可生效。`,
        );
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
  pump(id: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const existing = this.pumping.get(id);
    if (existing) return existing;
    const promise = this.doPump(id).finally(() => this.pumping.delete(id));
    this.pumping.set(id, promise);
    return promise;
  }
  private async doPump(id: string) {
    try {
      if (this.connecting.has(id)) return;
      let runtime = this.connections.get(id);
      if (!runtime) {
        const binding = this.binding(id);
        if (
          binding.runtime_id &&
          binding.runtime_pid &&
          alive(binding.runtime_pid)
        ) {
          await this.operation(id, () =>
            this.bind(id, { runtimeId: binding.runtime_id! }),
          );
          runtime = this.connections.get(id);
        } else {
          if (wakesOffline(this.store.pending(id))) await this.start(id, true);
          runtime = this.connections.get(id);
        }
      }
      if (!runtime) return;
      try {
        runtime.info = runtimeSchema.parse(
          await this.rpc("_pi/runtime/status", target(runtime.info)),
        );
        this.assertOpen();
        this.remember(id, runtime.info);
      } catch (error) {
        await this.rpc("_pi/runtime/detach", target(runtime.info)).catch(
          () => undefined,
        );
        this.connections.delete(id);
        throw error;
      }
      await this.capture(id, runtime.info);
      for (const pending of this.store.pending(id)) {
        if (pending.kind === "summary" && runtime.info.busy) continue;
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
          const result = await this.rpc<{ accepted: boolean }>(
            "_pi/runtime/deliver",
            {
              ...target(runtime.info),
              id: pending.id,
              source: "Atrium",
              text: pending.text,
              delivery: pending.kind === "direct" ? "steer" : "followUp",
              ...(images.length ? { images } : {}),
            },
          );
          this.assertOpen();
          if (!result.accepted) throw new Error("Pi 未确认接收");
          this.store.accepted(pending.id);
          this.changed();
        } catch (error) {
          if (!this.stopped)
            this.store.deliveryError(pending.id, String(error));
          break;
        }
      }
    } catch (error) {
      if (!this.stopped) {
        this.errors.set(id, String(error));
        this.changed();
      }
    }
  }
  private async capture(id: string, info: RuntimeInfo) {
    const before = this.traceErrors.get(id);
    try {
      // Bounded catch-up per tick; long gaps are reported, never fabricated.
      for (let page = 0; page < 2; page++) {
        const events = runtimeEvents.parse(
          await this.rpc("_pi/runtime/events", {
            ...target(info),
            after: this.traces.cursor(id, info.runtimeId, info.generation),
            limit: 50,
          }),
        );
        if (this.stopped || this.connections.get(id)?.info !== info) return;
        if (
          events.runtimeId !== info.runtimeId ||
          events.generation !== info.generation ||
          events.sessionId !== info.sessionId
        )
          throw new Error("轨迹来自其他运行代际");
        if (this.traces.ingest(id, events)) this.changed();
        if (!events.hasMore) break;
      }
      this.traceErrors.delete(id);
    } catch {
      if (!this.stopped)
        this.traceErrors.set(
          id,
          "暂时无法读取实时轨迹；请确认此 Pi 已加载支持轨迹的 pi-atrium 扩展。已有记录仍可查看。",
        );
    }
    if (!this.stopped && before !== this.traceErrors.get(id)) this.changed();
  }
  private async tick() {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      await this.discover();
      if (this.stopped) return;
      if (this.store.schedule().length) this.changed();
      await Promise.all(
        this.store.agents().map(async (agent) => {
          const before = JSON.stringify(this.connections.get(agent.id)?.info);
          await this.pump(agent.id);
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
    await Promise.allSettled([
      ...this.pumping.values(),
      ...this.connecting.values(),
      ...(this.opening ? [this.opening] : []),
      ...(this.scanning ? [this.scanning] : []),
      ...[...this.gateways].map((gateway) => this.stopGateway(gateway)),
    ]);
  }
}
