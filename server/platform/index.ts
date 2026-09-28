import {
  execFile,
  spawn,
  type ChildProcess,
  type ExecFileException,
  type ExecFileOptions,
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
  hiddenLaunch,
  isBatchFile,
  killTreePlan,
  launchInvocation,
  parseWindowsProcesses,
  pathDelimiter,
  shellInvocation,
  WINDOWS_PROCESS_LIST,
  windowsKillInvocation,
  windowsTreePids,
  type Invocation,
  type StopSignal,
} from "./plan.ts";

/**
 * 平台层的 IO（#t94）：结束进程树、判断进程存活、跑 shell 命令、按名字找并拉起可执行文件、收紧文件权限。
 * 判定在 `plan.ts`（纯函数、按平台穷举测试）；其余代码只调这里，不直接写 `process.kill(-pid)`、`/bin/sh`。
 * 子进程一律从这里拉起（t167，`tests/child-process-imports.test.ts` 把关）：都带 windowsHide，Windows 上不弹控制台窗口。
 */

export * from "./plan.ts";

/**
 * 结束整个进程树（拉起时须 detached，Unix 上才有独立进程组）；进程已不在时静默。
 * Windows：先列全机进程圈出整棵树，再一次 `taskkill /T /F` 结束（t167）——只靠 `taskkill /T`
 * 的话，结束时已先退出的中间进程（cmd、npm 包装、测试文件进程）下面的子孙会漏掉、一直占着 CPU。
 * 列不出进程时退回按根 `taskkill /T /F`。异步执行、不阻塞事件循环；返回的 Promise 在结束命令跑完时兑现，调用方可以不等。
 */
export function killTree(
  pid: number,
  signal: StopSignal = "SIGTERM",
): Promise<void> {
  const plan = killTreePlan(process.platform, pid, signal);
  if ("kind" in plan) {
    try {
      process.kill(plan.pid, signal);
    } catch {
      signalRoot(pid, signal);
    }
    return Promise.resolve();
  }
  return killWindowsTree(pid, plan, signal);
}

function signalRoot(pid: number, signal: StopSignal) {
  try {
    process.kill(pid, signal);
  } catch {
    // 已退出。
  }
}

async function killWindowsTree(
  pid: number,
  fallback: Invocation,
  signal: StopSignal,
) {
  let kill = fallback;
  const listed = await runFile(
    WINDOWS_PROCESS_LIST.command,
    WINDOWS_PROCESS_LIST.args,
    { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 },
  );
  if (!listed.error)
    kill = windowsKillInvocation(
      windowsTreePids(parseWindowsProcesses(listed.stdout), pid),
    );
  const done = await runFile(kill.command, kill.args, { timeout: 30_000 });
  // taskkill 拉不起来时至少结束根进程（有的进程已不在时 taskkill 也返回非零，照样补一下无妨）。
  if (done.error) signalRoot(pid, signal);
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

/** 标准输入是否要交给子进程（管道、文件、继承）；只有明确 ignore 的不要。 */
function takesStdin(stdio: SpawnOptions["stdio"]) {
  const first = Array.isArray(stdio) ? stdio[0] : stdio;
  return first !== "ignore";
}

/**
 * 拉起已解析好的调用；Windows 上不弹控制台窗口。
 * Windows 上要求 detached 的经隐藏控制台中转（`hiddenLaunch`），程序和它的子孙都在没有窗口的控制台里。
 */
export function spawnInvocation(
  invocation: Invocation,
  options: SpawnOptions = {},
): ChildProcess {
  const launch = hiddenLaunch(process.platform, invocation, options.detached, {
    nodePath: process.execPath,
    stdin: takesStdin(options.stdio),
  });
  return spawn(launch.invocation.command, launch.invocation.args, {
    ...options,
    detached: launch.detached,
    windowsHide: true,
    windowsVerbatimArguments: launch.invocation.verbatim,
  });
}

/**
 * 拉起 Atrium 自己的 node 进程（服务、升级 supervisor）：不经中转，detached 照调用方。
 * 这类进程没有控制台，它们再起的子进程都从本模块拉起、带 windowsHide，不会弹窗。
 */
export function spawnNode(
  args: readonly string[],
  options: SpawnOptions = {},
): ChildProcess {
  return spawn(process.execPath, args, { ...options, windowsHide: true });
}

export type FileRun = {
  error: ExecFileException | null;
  stdout: string;
  stderr: string;
};

/**
 * 跑一个程序并收集输出（git、gh、npm、PowerShell 等）：不经 shell、windowsHide；
 * 管道收输出时 Windows 上带 CREATE_NO_WINDOW，程序与它的子孙都不开窗口。失败放在 error 里，不抛。
 */
export function runFile(
  command: string,
  args: readonly string[],
  options: ExecFileOptions = {},
): Promise<FileRun> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { ...options, encoding: "utf8", windowsHide: true },
      (error, stdout, stderr) =>
        resolve({ error, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
}

/** 按 `commandInvocation` 解析后再 `runFile`（Windows 上 npm 这类 .cmd 包装）。 */
export function runCommand(
  command: string,
  args: readonly string[],
  options: ExecFileOptions = {},
): Promise<FileRun> {
  const call = commandInvocation(command, args, options.env ?? process.env);
  return runFile(call.command, call.args, {
    ...options,
    windowsVerbatimArguments: call.verbatim,
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
