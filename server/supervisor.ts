import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
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
import { reportDroppedIdentity, serviceEnvironment } from "./service-env.ts";
import { Problem } from "./problem.ts";
import { localFetch } from "./local-http.ts";
import { commandLineInvocation, runFile, spawnNode } from "./platform/index.ts";
import { probePort } from "./port-owner.ts";
// 命令行经 service.ts 也会加载本模块：node:http 用 getBuiltinModule 取，免得 ESM 包装连带加载 undici（t117，见 local-http.ts）。
const { request: httpRequest } = process.getBuiltinModule(
  "node:http",
) as typeof import("node:http");

export type RestartStatus =
  /** 旧版 `restart --when-idle` 的遗留状态：只认得出来，启动时丢弃（discardLegacyIdleRestart）。 */
  | "waiting_idle"
  | "idle_timeout"
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
  recoverOldPid?: number;
  repo?: string;
  newPid?: number;
  error?: string;
  failedVersion?: string;
  rollbackVersion?: string;
  finishedAt?: number;
};

function restartStatePath(data: string): string {
  return join(data, "restart-state.json");
}

export function readRestartState(data: string): RestartState | null {
  const path = restartStatePath(data);
  if (!existsSync(path)) return null;
  try {
    const state = JSON.parse(
      readFileSync(path, "utf8"),
    ) as Partial<RestartState>;
    if (
      !state ||
      typeof state.id !== "string" ||
      ![
        "waiting_idle",
        "idle_timeout",
        "stopping",
        "starting",
        "checking",
        "success",
        "rolling_back",
        "rolled_back",
        "failed",
      ].includes(state.status ?? "") ||
      !Number.isSafeInteger(state.supervisorPid) ||
      !Number.isSafeInteger(state.startedAt) ||
      typeof state.fromVersion !== "string" ||
      typeof state.data !== "string"
    )
      throw new Error("字段无效");
    return state as RestartState;
  } catch (error) {
    try {
      const preserved = `${path}.invalid-${Date.now()}-${process.pid}`;
      renameSync(path, preserved);
      console.warn(`重启状态记录损坏，已移至 ${preserved}：${String(error)}`);
    } catch (moveError) {
      console.warn(`重启状态记录损坏且无法挪开 ${path}：${String(moveError)}`);
    }
    return null;
  }
}

/**
 * 旧版 `restart --when-idle` 留下的 waiting_idle / idle_timeout：重启不再等空闲，
 * 这些记录只会挡派活、挡 restart。遇到就删掉并记日志；返回是否丢弃了。
 */
export function discardLegacyIdleRestart(data: string): boolean {
  const state = readRestartState(data);
  if (state?.status !== "waiting_idle" && state?.status !== "idle_timeout")
    return false;
  try {
    unlinkSync(restartStatePath(data));
    console.warn(
      `[${new Date().toISOString()}] 丢弃旧版待空闲重启记录（${state.id}，${state.status}）：重启已不需要等执行者空闲，不再挡派活`,
    );
  } catch (error) {
    console.warn(`丢弃旧版待空闲重启记录失败：${String(error)}`);
  }
  return true;
}

/** 另一个进程里的 supervisor 正在重启服务（旧服务在关、新服务在起）；本进程就是 supervisor 时不算。 */
export function restartInProgress(data: string): RestartState | null {
  const state = readRestartState(data);
  return state &&
    ["stopping", "starting", "checking", "rolling_back"].includes(
      state.status,
    ) &&
    state.supervisorPid > 0 &&
    state.supervisorPid !== process.pid &&
    alive(state.supervisorPid)
    ? state
    : null;
}

export function writeRestartState(data: string, state: RestartState): void {
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const path = restartStatePath(data);
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(state, null, 2), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

export async function checkServiceHealth(record: ServiceRecord): Promise<void> {
  // 1. 接口能响应
  const statusRes = await localFetch(`${serviceUrl(record)}/api/service`, {
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

  // 等待有界就绪，不能把首个尚未就绪的瞬间误判为失败。
  const deadline = Date.now() + 15000;
  let healthError = "服务未就绪";
  let ready = false;
  while (Date.now() < deadline) {
    if (!alive(record.pid)) throw new Error("服务在就绪前退出");
    const healthRes = await localFetch(
      `${serviceUrl(record)}/api/service/health`,
      {
        headers: { authorization: `Bearer ${record.token}` },
        signal: AbortSignal.timeout(6000),
      },
    );
    // 回滚到的旧版本在 runtimes 里报未就绪原因；ok 已涵盖它的可用性。
    const health = (await healthRes.json().catch(() => ({}))) as {
      ok?: boolean;
      runtimes?: { error?: string | null };
    };
    if (healthRes.ok && health.ok) {
      ready = true;
      break;
    }
    healthError = health.runtimes?.error ?? healthError;
    await delay(250);
  }
  if (!ready) throw new Error(`健康检查未通过：${healthError}`);
}

export type SupervisorLaunchOptions = {
  data: string;
  fromVersion?: string;
  targetVersion?: string;
  /** 旧服务排空的上限（毫秒）。 */
  agentTimeout?: number;
};

export async function startSupervisor(
  options: SupervisorLaunchOptions,
): Promise<{ pid: number; taskId: string }> {
  const data = options.data;
  const previous = readRestartState(data);
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
    recoverOldPid: previous?.status === "failed" ? previous.oldPid : undefined,
  };
  writeRestartState(data, initialState);

  const supervisorScript = join(packageRoot, "bin/restart-supervisor.mjs");
  const { env, droppedSensitive } = serviceEnvironment(process.env);
  reportDroppedIdentity(droppedSensitive);
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
    ...(options.agentTimeout
      ? ["--agent-timeout", String(options.agentTimeout)]
      : []),
  ];

  const child = spawnNode(args, {
    cwd: data,
    detached: true,
    stdio: ["ignore", log, log],
    env: {
      ...env,
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
): Promise<void> {
  // 长排空会超过 undici 默认 headersTimeout（约 300 秒，#231），全局 fetch
  // 会在响应头之前断开；改用 node:http，整体超时时只由 AbortSignal 控制。
  // 带上自己的 PID：旧服务排空完成后据此判断接手的 supervisor 是否还在（#244）。
  const bodyText = JSON.stringify({ timeout, supervisorPid: process.pid });
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
          res.on("error", reject);
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
      return JSON.parse(response.body) as { error?: string };
    } catch {
      return {};
    }
  })();
  if (response.status !== 200)
    throw new Error(
      `旧服务拒绝平滑退出（HTTP ${response.status}）：${parsed.error ?? "请检查旧服务日志"}`,
    );
}

/** 旧进程已停止监听时的最后接管。只处理原登记实例，且确认任务账本可读。 */
export async function reclaimStoppedService(
  record: ServiceRecord,
  data: string,
): Promise<void> {
  const current = readService(data);
  if (
    !current ||
    current.instance !== record.instance ||
    current.pid !== record.pid
  )
    throw new Error("旧服务登记已变化，不能按 PID 结束进程");
  if ((await probePort(record.port)).kind !== "free")
    throw new Error("旧服务仍在监听，不能强制结束进程");
  const db = new DatabaseSync(join(data, "atrium.sqlite"), { readOnly: true });
  try {
    // 执行者的 PID 和任务状态在账本中，新服务按这些记录接管。
    db.prepare("SELECT id, status, pid FROM tasks ORDER BY id LIMIT 1").all();
    const unrecorded = db
      .prepare(
        "SELECT id FROM tasks WHERE status='running' AND pid IS NULL LIMIT 1",
      )
      .get();
    if (unrecorded)
      throw new Error("有运行中任务尚未记录执行者 PID，不能结束旧服务");
  } finally {
    db.close();
  }
  if (!alive(record.pid)) return;
  // 登记可能在崩溃后残留，PID 也可能被系统复用；再核对进程命令（Windows 上经 PowerShell，慢一些）。
  const call = commandLineInvocation(process.platform, record.pid);
  const { error, stdout: command } = await runFile(call.command, call.args, {
    timeout: 15_000,
  });
  if (error) throw error;
  if (!/(?:^|[\s"/\\])server[/\\]main\.ts(?:["\s]|$)/.test(command))
    throw new Error("旧服务 PID 已不是 Atrium 服务进程，不能强制结束");
  // 只结束服务进程本身（Windows 上即强制结束），不按进程树：执行者要留给新服务接管。
  try {
    process.kill(record.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  for (let i = 0; i < 20 && alive(record.pid); i++) await delay(100);
  if (alive(record.pid)) {
    // 已验证实例、监听和持久化；SIGTERM 无效时旧进程不能继续挡住升级。
    try {
      process.kill(record.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    for (let i = 0; i < 30 && alive(record.pid); i++) await delay(100);
  }
  if (alive(record.pid)) throw new Error("旧服务进程仍未退出");
}

export async function runSupervisor(args: string[]): Promise<void> {
  let data = "";
  let taskId = "";
  let fromVersion = "";
  let targetVersion: string | undefined;
  let agentTimeout = 300000;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--data" && args[i + 1]) data = args[++i];
    else if (args[i] === "--task-id" && args[i + 1]) taskId = args[++i];
    else if (args[i] === "--from-version" && args[i + 1])
      fromVersion = args[++i];
    else if (args[i] === "--target-version" && args[i + 1])
      targetVersion = args[++i];
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
  const oldRecord = readService(data);
  if (oldRecord && alive(oldRecord.pid)) {
    state.oldPid = oldRecord.pid;
    writeRestartState(data, state);
    try {
      try {
        await requestDrain(oldRecord, agentTimeout);
      } catch (error) {
        // 上一轮升级已确认旧服务关监听但没退出；重新运行 restart 可接管。
        if (state.recoverOldPid !== oldRecord.pid) throw error;
        await reclaimStoppedService(oldRecord, data);
      }
      if (alive(oldRecord.pid)) {
        try {
          await stopService(data);
        } catch (error) {
          console.warn(
            `旧服务未按时退出，检查持久化记录后接管：${String(error)}`,
          );
          await reclaimStoppedService(oldRecord, data);
        }
      }
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

    await checkServiceHealth(newRecord);
    const reported = (await (
      await localFetch(`${serviceUrl(newRecord)}/api/service`, {
        headers: { authorization: `Bearer ${newRecord.token}` },
      })
    ).json()) as { version: string };
    if (reported.version !== state.targetVersion)
      throw new Error(
        `启动版本不符：预期 ${state.targetVersion}，实际 ${reported.version}`,
      );

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
      await checkServiceHealth(rolledBack);
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
