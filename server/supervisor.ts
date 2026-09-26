import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  alive,
  currentVersion,
  packageRoot,
  readService,
  serviceUrl,
  type ServiceRecord,
} from "./service-state.ts";
import { startService, stopService } from "./service.ts";
import { installVersion } from "./install-version.ts";
import { Store, Problem } from "./store.ts";

export type RestartStatus =
  | "stopping"
  | "starting"
  | "checking"
  | "success"
  | "rolling_back"
  | "rolled_back"
  | "failed";

export type RestartState = {
  id: string;
  status: RestartStatus;
  supervisorPid: number;
  startedAt: number;
  fromVersion: string;
  targetVersion?: string;
  data: string;
  oldPid?: number;
  repo?: string;
  newPid?: number;
  agentsToWake?: string[];
  wokenAgents?: string[];
  error?: string;
  failedVersion?: string;
  rollbackVersion?: string;
  finishedAt?: number;
};

export function restartStatePath(data: string): string {
  return join(data, "restart-state.json");
}

export function readRestartState(data: string): RestartState | null {
  const path = restartStatePath(data);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RestartState;
  } catch {
    return null;
  }
}

export function writeRestartState(data: string, state: RestartState): void {
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const path = restartStatePath(data);
  writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
}

export async function checkServiceHealth(
  record: ServiceRecord,
  data: string,
  options?: { probeAgent?: string },
): Promise<void> {
  // 1. 接口能响应
  const statusRes = await fetch(`${serviceUrl(record)}/api/service`, {
    headers: { authorization: `Bearer ${record.token}` },
    signal: AbortSignal.timeout(4000),
  });
  if (!statusRes.ok)
    throw new Error(`服务接口无响应 (HTTP ${statusRes.status})`);
  const statusJson = (await statusRes.json()) as {
    instance: string;
    pid: number;
    stopping: boolean;
  };
  if (statusJson.instance !== record.instance || statusJson.pid !== record.pid)
    throw new Error("服务身份不匹配");
  if (statusJson.stopping) throw new Error("服务仍处于 stopping 状态");

  // 网关异步启动；等待有界就绪，不能把首个尚未握手的瞬间误判为失败。
  const deadline = Date.now() + 15000;
  let healthError = "网关未就绪";
  let ready = false;
  while (Date.now() < deadline) {
    if (!alive(record.pid)) throw new Error("服务在网关握手前退出");
    const healthRes = await fetch(`${serviceUrl(record)}/api/service/health`, {
      headers: { authorization: `Bearer ${record.token}` },
      signal: AbortSignal.timeout(6000),
    });
    const health = (await healthRes.json().catch(() => ({}))) as {
      ok?: boolean;
      runtimes?: { available?: boolean; error?: string | null };
    };
    if (healthRes.ok && health.ok && health.runtimes?.available) {
      ready = true;
      break;
    }
    healthError = health.runtimes?.error ?? healthError;
    await delay(250);
  }
  if (!ready) throw new Error(`健康检查未通过：${healthError}`);

  // A real model turn is an optional, explicit acceptance check. The service
  // and MCP gateway can be healthy when credentials or providers are offline.
  if (options?.probeAgent) {
    const probeRes = await fetch(`${serviceUrl(record)}/api/service/probe`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${record.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: options.probeAgent }),
      signal: AbortSignal.timeout(70000),
    });
    if (!probeRes.ok) {
      const body = (await probeRes.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new Error(`身份回合验证失败：${body.error ?? probeRes.status}`);
    }
  }
}

export function sendRollbackNotification(
  data: string,
  details: { fromVersion: string; failedVersion: string; error: string },
) {
  try {
    const dbPath = join(data, "atrium.sqlite");
    if (!existsSync(dbPath)) return;
    const store = new Store(dbPath);
    try {
      const agents = store.agents();
      const targetAgentId = agents[0]?.id;
      if (targetAgentId) {
        store.run(
          `INSERT INTO inbox(agent_id, source, title, body, created_at) VALUES(?, 'system', 'Atrium 升级回滚', ?, ?)`,
          targetAgentId,
          `Atrium 启动失败，已自动回滚至 v${details.fromVersion}。\n原版本：v${details.fromVersion}\n失败版本：v${details.failedVersion}\n失败原因：${details.error}`,
          Date.now(),
        );
      }
    } finally {
      store.close();
    }
  } catch (e) {
    console.warn("记录回滚通知至数据库失败：", e);
  }
}

export type SupervisorLaunchOptions = {
  data: string;
  fromVersion?: string;
  targetVersion?: string;
  probeAgent?: string;
  wakeAgent?: string;
  agentTimeout?: number;
};

export async function startSupervisor(
  options: SupervisorLaunchOptions,
): Promise<{ pid: number; taskId: string }> {
  const data = options.data;
  const taskId = `rst-${Date.now()}`;
  const pendingPath = join(data, "pending-update.json");
  const pending = existsSync(pendingPath)
    ? (JSON.parse(readFileSync(pendingPath, "utf8")) as {
        from: string;
        to: string;
        repo: string;
      })
    : null;
  if (pending && pending.to !== currentVersion())
    throw new Error("待生效版本与当前安装版本不符；请重新运行 atrium update");
  const fromVersion = options.fromVersion ?? pending?.from ?? currentVersion();

  const initialState: RestartState = {
    id: taskId,
    status: "stopping",
    supervisorPid: 0,
    startedAt: Date.now(),
    fromVersion,
    targetVersion: options.targetVersion ?? pending?.to ?? currentVersion(),
    repo: pending?.repo ?? process.env.ATRIUM_UPDATE_REPO,
    data,
  };
  writeRestartState(data, initialState);

  const supervisorScript = join(packageRoot, "bin/restart-supervisor.mjs");
  const logPath = join(data, "supervisor.log");
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const log = openSync(logPath, "a", 0o600);

  const args = [
    supervisorScript,
    "--data",
    data,
    "--task-id",
    taskId,
    "--from-version",
    fromVersion,
    ...(options.targetVersion
      ? ["--target-version", options.targetVersion]
      : []),
    ...(options.probeAgent ? ["--probe-agent", options.probeAgent] : []),
    ...(options.wakeAgent ? ["--wake-agent", options.wakeAgent] : []),
    ...(options.agentTimeout
      ? ["--agent-timeout", String(options.agentTimeout)]
      : []),
  ];

  const child = spawn(process.execPath, args, {
    cwd: packageRoot,
    detached: true,
    stdio: ["ignore", log, log],
    windowsHide: true,
    env: {
      ...process.env,
      ATRIUM_DATA: data,
    },
  });
  closeSync(log);
  child.unref();

  initialState.supervisorPid = child.pid!;
  writeRestartState(data, initialState);

  return { pid: child.pid!, taskId };
}

export async function requestDrain(
  record: ServiceRecord,
  timeout: number,
): Promise<string[]> {
  // 长排空会超过 undici 默认 headersTimeout（约 300 秒，#231），全局 fetch
  // 会在响应头之前断开；改用 node:http，整体超时时只由 AbortSignal 控制。
  const bodyText = JSON.stringify({ timeout });
  const response = await new Promise<{ status: number; body: string }>(
    (resolvePromise, reject) => {
      const req = httpRequest(
        `${serviceUrl(record)}/api/service/prepare-restart`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${record.token}`,
            "content-type": "application/json",
            "content-length": Buffer.byteLength(bodyText),
          },
          signal: AbortSignal.timeout(timeout + 10000),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () =>
            resolvePromise({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(bodyText);
    },
  );
  const parsed = (() => {
    try {
      return JSON.parse(response.body) as {
        error?: string;
        agentsToWake?: string[];
      };
    } catch {
      return {};
    }
  })();
  if (response.status !== 200)
    throw new Error(
      `旧服务拒绝平滑退出（HTTP ${response.status}）：${parsed.error ?? "请检查旧服务日志"}`,
    );
  return parsed.agentsToWake ?? [];
}

export async function runSupervisor(args: string[]): Promise<void> {
  let data = "";
  let taskId = "";
  let fromVersion = "";
  let targetVersion: string | undefined;
  let probeAgent: string | undefined;
  let wakeAgent: string | undefined;
  let agentTimeout = 300000;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--data" && args[i + 1]) data = args[++i];
    else if (args[i] === "--task-id" && args[i + 1]) taskId = args[++i];
    else if (args[i] === "--from-version" && args[i + 1])
      fromVersion = args[++i];
    else if (args[i] === "--target-version" && args[i + 1])
      targetVersion = args[++i];
    else if (args[i] === "--probe-agent" && args[i + 1]) probeAgent = args[++i];
    else if (args[i] === "--wake-agent" && args[i + 1]) wakeAgent = args[++i];
    else if (args[i] === "--agent-timeout" && args[i + 1])
      agentTimeout = Number(args[++i]);
  }

  if (!data) throw new Error("缺少 --data 参数");
  const state: RestartState = readRestartState(data) ?? {
    id: taskId || `rst-${Date.now()}`,
    status: "stopping",
    supervisorPid: process.pid,
    startedAt: Date.now(),
    fromVersion: fromVersion || currentVersion(),
    targetVersion,
    data,
  };
  state.supervisorPid = process.pid;
  writeRestartState(data, state);

  // 1. 停止当前旧服务
  let agentsToWake: string[] = wakeAgent ? [wakeAgent] : [];
  state.agentsToWake = agentsToWake;
  const oldRecord = readService(data);
  if (oldRecord && alive(oldRecord.pid)) {
    state.oldPid = oldRecord.pid;
    writeRestartState(data, state);
    try {
      agentsToWake = [
        ...new Set([
          ...agentsToWake,
          ...(await requestDrain(oldRecord, agentTimeout)),
        ]),
      ];
      state.agentsToWake = agentsToWake;
      writeRestartState(data, state);
      await stopService(data);
    } catch (error) {
      state.status = "failed";
      state.error = `旧服务未停止：${String(error)}`;
      state.finishedAt = Date.now();
      writeRestartState(data, state);
      return;
    }
  }

  // 2. 启动新版本服务并进行健康检查
  state.status = "starting";
  writeRestartState(data, state);

  let newRecord: ServiceRecord | undefined;
  try {
    newRecord = await startService(data);
    state.newPid = newRecord.pid;
    state.status = "checking";
    writeRestartState(data, state);

    await checkServiceHealth(newRecord, data, { probeAgent });
    const reported = (await (
      await fetch(`${serviceUrl(newRecord)}/api/service`, {
        headers: { authorization: `Bearer ${newRecord.token}` },
      })
    ).json()) as { version: string };
    if (reported.version !== state.targetVersion)
      throw new Error(
        `启动版本不符：预期 ${state.targetVersion}，实际 ${reported.version}`,
      );

    // 唤醒此前正在干活的 Agent；唤醒失败不得报告成功。
    // The probe identity has already finished a turn but still needs a resume message.
    const woken: string[] = [];
    for (const agentId of state.agentsToWake ?? []) {
      try {
        const response = await fetch(
          `${serviceUrl(newRecord)}/api/service/wake`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${newRecord.token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ id: agentId }),
            signal: AbortSignal.timeout(10000),
          },
        );
        if (!response.ok)
          throw new Error(`唤醒 ${agentId} 失败：HTTP ${response.status}`);
        woken.push(agentId);
      } catch (err) {
        throw new Error(`重启后身份续跑失败：${String(err)}`);
      }
    }
    state.wokenAgents = woken;
    state.status = "success";
    state.finishedAt = Date.now();
    writeRestartState(data, state);
    const pendingPath = join(data, "pending-update.json");
    if (existsSync(pendingPath)) unlinkSync(pendingPath);
    return;
  } catch (err) {
    // 启动或健康检查失败：触发自动回滚！
    console.error("新版本启动或健康检查失败，准备自动回滚：", err);
    state.status = "rolling_back";
    state.error = (err as Error).message;
    state.failedVersion = state.targetVersion ?? currentVersion();
    state.rollbackVersion = state.fromVersion;
    writeRestartState(data, state);

    // 只用经实例校验的服务控制接口，不按 PID 强杀。
    try {
      if (newRecord) await stopService(data);
    } catch (stopError) {
      state.status = "failed";
      state.error += `；无法停止失败版本：${String(stopError)}`;
      state.finishedAt = Date.now();
      writeRestartState(data, state);
      return;
    }

    // 装回上一个版本
    if (state.fromVersion && state.fromVersion !== state.failedVersion) {
      try {
        await installVersion(
          state.fromVersion,
          state.repo ?? "github:liu-zhengdong/atrium",
        );
      } catch (rollbackErr) {
        state.status = "failed";
        state.error += `；装回旧版本失败：${String(rollbackErr)}`;
        state.finishedAt = Date.now();
        writeRestartState(data, state);
        return;
      }
    }

    // 重新启动旧版本服务
    try {
      const rolledBack = await startService(data);
      state.newPid = rolledBack.pid;
      await checkServiceHealth(rolledBack, data);
      sendRollbackNotification(data, {
        fromVersion: state.fromVersion,
        failedVersion: state.failedVersion,
        error: state.error,
      });
    } catch (startOldErr) {
      state.status = "failed";
      state.error += `；回滚版本未能启动：${String(startOldErr)}`;
      state.finishedAt = Date.now();
      writeRestartState(data, state);
      return;
    }

    state.status = "rolled_back";
    state.finishedAt = Date.now();
    writeRestartState(data, state);
    const pendingPath = join(data, "pending-update.json");
    if (existsSync(pendingPath)) unlinkSync(pendingPath);
    process.exitCode = 1;
  }
}

export async function waitForRestart(
  data: string,
  timeoutMs = 300000,
): Promise<RestartState> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = readRestartState(data);
    if (state) {
      if (
        state.status === "success" ||
        state.status === "rolled_back" ||
        state.status === "failed"
      ) {
        return state;
      }
    }
    await delay(100);
  }
  const state = readRestartState(data);
  throw new Problem(
    504,
    `等待平滑重启超时（当前：${state?.status ?? "尚未启动"}）；后台任务仍可能在继续。运行 atrium restart --wait --timeout 300 查看最终结果`,
    "restart_timeout",
  );
}
