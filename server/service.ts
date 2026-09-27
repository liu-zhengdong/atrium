import { spawn, execFile } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { portTakenMessage, probePort } from "./port-owner.ts";
import { Problem } from "./problem.ts";
import {
  alive,
  legacyDataNotice,
  packageRoot,
  readService,
  servicePort,
  serviceUrl,
  type ServiceRecord,
} from "./service-state.ts";
import { reportDroppedIdentity, serviceEnvironment } from "./service-env.ts";
import { restartInProgress } from "./supervisor.ts";
import { localFetch } from "./local-http.ts";

async function request(record: ServiceRecord, stop = false) {
  const response = await localFetch(
    `${serviceUrl(record)}/api/service${stop ? "/stop" : ""}`,
    {
      method: stop ? "POST" : "GET",
      headers: { authorization: `Bearer ${record.token}` },
      signal: AbortSignal.timeout(700),
    },
  );
  if (!response.ok) throw new Error("服务身份校验失败");
  const result = (await response.json()) as {
    instance?: string;
    pid?: number;
    stopping?: boolean;
  };
  if (result.instance !== record.instance || result.pid !== record.pid)
    throw new Error("服务身份不匹配");
  return result;
}
async function probe(record: ServiceRecord) {
  try {
    return (await request(record)).stopping ? "stopping" : "ready";
  } catch {
    return "down";
  }
}
function logSize(data: string) {
  try {
    return statSync(join(data, "service.log")).size;
  } catch {
    return 0;
  }
}
function startupFailure(data: string, reason: string, logStart: number): Error {
  const path = join(data, "service.log");
  let recent = "";
  try {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      const buffer = Buffer.alloc(Math.min(Math.max(size - logStart, 0), 4096));
      const bytes = readSync(
        fd,
        buffer,
        0,
        buffer.length,
        size - buffer.length,
      );
      recent = buffer
        .subarray(0, bytes)
        .toString("utf8")
        .trim()
        .split("\n")
        .slice(-10)
        .join("\n");
    } finally {
      closeSync(fd);
    }
  } catch {
    /* A missing or unreadable log must not hide the startup error. */
  }
  return new Error(
    `${reason}；日志：${path}${recent ? `\n最近输出：\n${recent}` : ""}`,
  );
}
function unavailable(record: ServiceRecord, data: string) {
  return new Error(
    `PID ${record.pid} 仍存在，但服务未就绪或身份不匹配；不会重复启动或按 PID 强杀。请检查 ${join(data, "service.log")}`,
  );
}
// #231：能应答但 stopping=true 时给出明确的下一步，不再只报「未就绪」。
async function unavailableReason(
  record: ServiceRecord,
  data: string,
): Promise<Error> {
  try {
    if ((await request(record)).stopping === true)
      return new Error(
        "服务正在平滑重启或关闭中；有进行中的重启时运行 atrium restart --wait 等结果，没有时运行 atrium restart 接管升级",
      );
  } catch {
    /* 真正不可用的服务按原样处理 */
  }
  return unavailable(record, data);
}
export async function serviceStatus(data: string) {
  const record = readService(data);
  if (!record || !alive(record.pid)) {
    const legacy = !existsSync(data) && legacyDataNotice();
    console.log(`Atrium 未运行\n数据：${data}${legacy ? `\n${legacy}` : ""}`);
    return;
  }
  const current = await request(record).catch(() => {
    throw unavailable(record, data);
  });
  if (current.stopping) throw await unavailableReason(record, data);
  console.log(
    `Atrium 正在运行 · PID ${record.pid}\n${serviceUrl(record)}\n数据：${data}\n日志：${join(data, "service.log")}（后台启动）`,
  );
}
export async function stopService(data: string) {
  const record = readService(data);
  if (!record || !alive(record.pid)) {
    console.log("Atrium 已停止");
    return;
  }
  try {
    await request(record); // Verify the recorded instance before requesting shutdown.
    await request(record, true);
  } catch {
    throw unavailable(record, data);
  }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const current = readService(data);
    if (
      !current ||
      current.instance !== record.instance ||
      !alive(record.pid)
    ) {
      console.log("Atrium 已停止；数据已保留");
      return;
    }
    await delay(100);
  }
  throw new Error(
    "Atrium 仍在关闭；未强制终止进程。请稍后运行 atrium status。",
  );
}
/**
 * 冷启动等待（#262）：机器忙时 tsx 加载加开库要十几秒，不能按固定窗口判死。
 * 自己拉起的进程还活着就一直等；别人拉起或已在跑但未就绪的，
 * 登记文件或日志在 stallMs 内有推进才继续等。总上限 totalMs；进程退出立即失败。
 */
export type StartWaitOptions = {
  totalMs?: number;
  stallMs?: number;
  noticeMs?: number;
  notice?: (message: string) => void;
  /** 测试用：替换服务入口脚本（相对 packageRoot 或绝对路径）。 */
  entry?: string;
};
export async function startService(
  data: string,
  {
    totalMs = 60000,
    stallMs = 12000,
    noticeMs = 5000,
    notice = (message: string) => console.error(message),
    entry = "server/main.ts",
  }: StartWaitOptions = {},
) {
  // 重启进行中：旧服务在关、新服务由 supervisor 拉起。这里不抢着自己拉，等新服务
  // 就绪后照常返回，调用方（task run / task add 等）看不出中断。
  const waitStarted = Date.now();
  let waitNoticed = false;
  for (let state = restartInProgress(data); state;) {
    const current = readService(data);
    if (
      current &&
      alive(current.pid) &&
      (await probe(current)) === "ready" &&
      state.status !== "stopping"
    )
      return current;
    if (Date.now() - waitStarted >= totalMs)
      throw new Error(
        `Atrium 正在重启（${state.status}），已等 ${Math.round(totalMs / 1000)} 秒仍未就绪；运行 atrium restart --wait 查看结果`,
      );
    if (!waitNoticed && Date.now() - waitStarted >= noticeMs) {
      waitNoticed = true;
      notice("Atrium 正在重启，等新服务就绪…");
    }
    await delay(100);
    state = restartInProgress(data);
  }
  let record = readService(data);
  let child: ReturnType<typeof spawn> | undefined;
  let launchError: Error | undefined;
  let logStart = 0;
  if (!record || !alive(record.pid)) {
    const port = servicePort();
    // t71：端口已被别的程序或另一份数据的 Atrium 占着，就不拉起服务、不建数据目录。
    const taken = portTakenMessage(port, await probePort(port), data);
    if (taken) throw new Problem(409, `Atrium 未启动：${taken}`, "conflict");
    const legacy = !existsSync(data) && legacyDataNotice();
    if (legacy) notice(legacy);
    mkdirSync(data, { recursive: true, mode: 0o700 });
    const log = openSync(join(data, "service.log"), "a", 0o600);
    logStart = fstatSync(log).size;
    try {
      const { env, droppedSensitive } = serviceEnvironment(process.env);
      reportDroppedIdentity(droppedSensitive);
      child = spawn(
        process.execPath,
        ["--import", import.meta.resolve("tsx"), resolve(packageRoot, entry)],
        {
          cwd: data,
          env: {
            ...env,
            ATRIUM_DATA: data,
          },
          detached: true,
          stdio: ["ignore", log, log],
          windowsHide: true,
        },
      );
      child.on("error", (error) => {
        launchError = error;
      });
      child.unref();
    } finally {
      closeSync(log);
    }
  }
  const started = Date.now();
  let lastProgress = started;
  let lastInstance = record?.instance;
  let lastLog = logSize(data);
  let noticed = false;
  for (;;) {
    if (launchError) throw launchError;
    record = readService(data);
    const state =
      record && alive(record.pid) ? await probe(record) : ("down" as const);
    if (state === "ready") return record!;
    // A concurrent starter can lose the claim while the winning child is still starting.
    const childExited = child?.exitCode != null || child?.signalCode != null;
    if (childExited && (!record || !alive(record.pid)))
      throw startupFailure(
        data,
        `Atrium 启动失败（${child!.exitCode != null ? `退出码 ${child!.exitCode}` : `信号 ${child!.signalCode}`}）`,
        logStart,
      );
    const now = Date.now();
    // 已应答但在关闭中的服务不算「启动中」，日志增长不延长等待。
    if (state === "down") {
      const size = logSize(data);
      if (record?.instance !== lastInstance || size !== lastLog)
        lastProgress = now;
      lastInstance = record?.instance;
      lastLog = size;
    }
    const ours = child !== undefined && !childExited;
    if (now - started >= totalMs || (!ours && now - lastProgress >= stallMs))
      break;
    if (!noticed && now - started >= noticeMs) {
      noticed = true;
      notice(
        `Atrium 服务启动中…（最长等 ${Math.round(totalMs / 1000)} 秒；日志：${join(data, "service.log")}）`,
      );
    }
    await delay(100);
  }
  if (record && alive(record.pid)) throw await unavailableReason(record, data);
  throw startupFailure(
    data,
    `Atrium 启动超时（已等 ${Math.round((Date.now() - started) / 1000)} 秒）`,
    logStart,
  );
}
