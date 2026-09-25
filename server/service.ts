import { spawn, execFile } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import {
  alive,
  packageRoot,
  readService,
  servicePort,
  serviceUrl,
  type ServiceRecord,
} from "./service-state.ts";
import { ensureWebDist } from "./web-dist.ts";
import {
  cleanIdentityEnvironment,
  identityEnvironmentContext,
} from "./identity-env.ts";

async function request(record: ServiceRecord, stop = false) {
  const response = await fetch(
    `${serviceUrl(record)}/api/service${stop ? "/stop" : ""}`,
    {
      method: stop ? "POST" : "GET",
      headers: { authorization: `Bearer ${record.token}` },
      redirect: "error",
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
async function ready(record: ServiceRecord) {
  try {
    return !(await request(record)).stopping;
  } catch {
    return false;
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
export async function serviceStatus(data: string) {
  const record = readService(data);
  if (!record || !alive(record.pid)) {
    console.log(`Atrium 未运行\n数据：${data}`);
    return;
  }
  if (!(await ready(record))) throw unavailable(record, data);
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
export async function startService(data: string) {
  await ensureWebDist(packageRoot);
  let record = readService(data);
  let child: ReturnType<typeof spawn> | undefined;
  let launchError: Error | undefined;
  let logStart = 0;
  if (!record || !alive(record.pid)) {
    servicePort();
    if (!existsSync(join(packageRoot, "dist/index.html")))
      throw new Error(
        `Web 构建后仍缺少 ${join(packageRoot, "dist/index.html")}`,
      );
    mkdirSync(data, { recursive: true, mode: 0o700 });
    const log = openSync(join(data, "service.log"), "a", 0o600);
    logStart = fstatSync(log).size;
    try {
      const cleaned = cleanIdentityEnvironment(
        process.env,
        identityEnvironmentContext(process.env),
      );
      child = spawn(
        process.execPath,
        ["--import", "tsx", join(packageRoot, "server/main.ts")],
        {
          cwd: packageRoot,
          env: {
            ...cleaned.env,
            ATRIUM_DATA: data,
            ...(cleaned.ignored.length
              ? { ATRIUM_IGNORED_IDENTITY_ENV: cleaned.ignored.join(",") }
              : {}),
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
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    record = readService(data);
    if (record && alive(record.pid) && (await ready(record))) return record;
    // A concurrent starter can lose the claim while the winning child is still starting.
    if (
      (child?.exitCode != null || child?.signalCode) &&
      (!record || !alive(record.pid))
    )
      throw startupFailure(
        data,
        `Atrium 启动失败（${child.exitCode != null ? `退出码 ${child.exitCode}` : `信号 ${child.signalCode}`}）`,
        logStart,
      );
    await delay(100);
  }
  if (record && alive(record.pid)) throw unavailable(record, data);
  throw startupFailure(data, "Atrium 启动超时", logStart);
}
export async function openWeb(record: ServiceRecord) {
  const url = serviceUrl(record);
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    await promisify(execFile)(command, args, {
      timeout: 10000,
      windowsHide: true,
    });
  } catch {
    console.error(`无法自动打开浏览器；服务已就绪，请手动打开 ${url}`);
  }
}
