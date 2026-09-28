import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { SshConnection } from "../hosts/tunnel-plan.ts";
import { tunnelArgs } from "../hosts/tunnel-plan.ts";
import { serviceEnvironment } from "../service-env.ts";
import {
  executableNames,
  isBatchFile,
  killTreePlan,
  launchInvocation,
  pathDelimiter,
  shellInvocation,
  spawnDetached,
  type Invocation,
  type StopSignal,
} from "./plan.ts";

/**
 * 平台层的 IO（#t94）：结束进程树、判断进程存活、跑 shell 命令、按名字找并拉起可执行文件、收紧文件权限。
 * 判定在 `plan.ts`（纯函数、按平台穷举测试）；其余代码只调这里，不直接写 `process.kill(-pid)`、`/bin/sh`。
 */

export * from "./plan.ts";

/**
 * 结束整个进程树（拉起时须 detached，Unix 上才有独立进程组）；进程已不在时静默。
 * Windows 用 `taskkill /T /F`，异步执行、不阻塞事件循环。
 */
export function killTree(pid: number, signal: StopSignal = "SIGTERM") {
  const plan = killTreePlan(process.platform, pid, signal);
  if ("kind" in plan) {
    try {
      process.kill(plan.pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // 已退出。
      }
    }
    return;
  }
  try {
    const child = spawn(plan.command, plan.args, {
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => {
      try {
        process.kill(pid, signal);
      } catch {
        // 已退出。
      }
    });
    child.unref();
  } catch {
    // taskkill 拉不起来时至少结束根进程。
    try {
      process.kill(pid, signal);
    } catch {
      // 已退出。
    }
  }
}

/** 进程是否还在：无权发信号（EPERM）也算在。 */
export function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 在 PATH 上找可执行文件（Windows 按 PATHEXT 补扩展名）；只读检查，不执行。 */
export function findExecutable(
  name: string,
  path = process.env.PATH ?? "",
  pathext = process.env.PATHEXT,
): string | undefined {
  const names = executableNames(process.platform, name, pathext);
  for (const dir of path.split(pathDelimiter(process.platform))) {
    if (!dir) continue;
    for (const candidate of names) {
      const file = join(dir, candidate);
      try {
        if (!statSync(file).isFile()) continue;
        if (process.platform !== "win32") accessSync(file, constants.X_OK);
        return file;
      } catch {
        // 不存在或不可执行，继续找。
      }
    }
  }
  return undefined;
}

/** 按名字（或路径）解析出真正的进程调用：PATH 查找、Windows 的 .cmd 包装。 */
export function commandInvocation(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Invocation {
  const file = /[\\/]/.test(command)
    ? command
    : (findExecutable(command, env.PATH ?? "", env.PATHEXT) ?? command);
  let shim: { text: string; dir: string } | undefined;
  if (isBatchFile(process.platform, file))
    try {
      shim = { text: readFileSync(file, "utf8"), dir: dirname(file) };
    } catch {
      // 读不到包装内容就经 cmd.exe 跑。
    }
  return launchInvocation({
    platform: process.platform,
    file,
    args,
    comspec: env.COMSPEC ?? process.env.ComSpec,
    shim,
    nodePath: process.execPath,
  });
}

/** 拉起已解析好的调用；Windows 上不弹控制台窗口。 */
export function spawnInvocation(
  invocation: Invocation,
  options: SpawnOptions = {},
): ChildProcess {
  return spawn(invocation.command, invocation.args, {
    ...options,
    detached: spawnDetached(process.platform, invocation, options.detached),
    windowsHide: true,
    windowsVerbatimArguments: invocation.verbatim,
  });
}

/** 按名字拉起程序：解析同 `commandInvocation`。 */
export function spawnCommand(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
): ChildProcess {
  return spawnInvocation(
    commandInvocation(command, args, options.env ?? process.env),
    options,
  );
}

/** 跑一条 shell 命令：Unix `/bin/sh -c`，Windows `cmd.exe /d /s /c`。 */
export function spawnShell(
  command: string,
  options: SpawnOptions = {},
): ChildProcess {
  return spawnInvocation(
    shellInvocation(
      process.platform,
      command,
      (options.env ?? process.env).COMSPEC ?? process.env.ComSpec,
    ),
    options,
  );
}

/** 凭据文件只留给本人：Unix 设 0600；Windows 没有这套权限位，数据目录在用户目录下，由 ACL 继承保护。 */
export function restrictToOwner(path: string) {
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

/** 只把私钥路径交给 SSH；环境仍按服务白名单过滤，绝不读取私钥内容。 */
export function spawnSshTunnel(connection: SshConnection): ChildProcess {
  const key = connection.key?.startsWith("~/")
    ? join(homedir(), connection.key.slice(2))
    : connection.key;
  return spawnCommand("ssh", tunnelArgs(connection, key ?? null), {
    env: serviceEnvironment().env,
    stdio: ["ignore", "ignore", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
}

export function stopSshTunnel(child: ChildProcess) {
  if (child.pid) killTree(child.pid);
}
