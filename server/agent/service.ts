import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import {
  processAlive,
  restrictToOwner,
  runCommand,
} from "../platform/index.ts";
import { Problem } from "../problem.ts";
import { packageRoot } from "../service-state.ts";
import { agentAlive } from "./run.ts";
import {
  afterUninstallSteps,
  installSteps,
  lingerOn,
  lingerQuery,
  parseStatus,
  serviceDefinitionFiles,
  serviceLayout,
  servicePlatform,
  statusQuery,
  uninstallSteps,
  type ServiceFile,
  type ServiceLayout,
  type ServiceState,
  type Step,
} from "./service-plan.ts";
import { AgentState } from "./state.ts";

/**
 * 代理装成系统服务（t183）的 IO：写服务文件、调 launchctl / systemctl / schtasks、读状态。
 * 判定在 `service-plan.ts`；测试用假的 launchctl / systemctl / schtasks（PATH 里只放假命令），不往本机注册服务。
 */

export type Ran = { ok: boolean; stdout: string; stderr: string };

export type ServiceDeps = {
  platform?: NodeJS.Platform;
  /** 找系统命令用的环境（PATH），也是写进 service-env.json 的来源。 */
  env?: NodeJS.ProcessEnv;
  home?: string;
  uid?: number;
  user?: string;
  node?: string;
  script?: string;
  /** 重试之间的等待（测试里给 0）。 */
  retryMs?: number;
};

type Resolved = {
  layout: ServiceLayout;
  env: NodeJS.ProcessEnv;
  user: string;
  retryMs: number;
};

function resolve(data: string, deps: ServiceDeps): Resolved {
  const platform = servicePlatform(deps.platform ?? process.platform);
  if (!platform)
    throw new Problem(
      400,
      `这个系统（${deps.platform ?? process.platform}）还不支持装成系统服务；前台运行 atrium agent`,
      "unsupported",
    );
  const env = deps.env ?? process.env;
  const user = deps.user ?? env.USER ?? userInfo().username;
  const layout = serviceLayout({
    platform,
    node: deps.node ?? process.execPath,
    script: deps.script ?? join(packageRoot, "bin", "atrium.mjs"),
    data,
    home: deps.home ?? env.HOME ?? homedir(),
    env,
    uid: deps.uid ?? process.getuid?.(),
    user,
  });
  if ("error" in layout) throw new Problem(400, layout.error, "unsupported");
  return { layout, env, user, retryMs: deps.retryMs ?? 1000 };
}

async function run(env: NodeJS.ProcessEnv, command: string, args: string[]) {
  const result = await runCommand(command, args, {
    env,
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  return {
    ok: !result.error,
    stdout: result.stdout,
    stderr: result.stderr || (result.error?.message ?? ""),
  } satisfies Ran;
}

const sameFile = (file: ServiceFile) => {
  try {
    return readFileSync(file.path).equals(fileBytes(file));
  } catch {
    return false;
  }
};

const fileBytes = (file: ServiceFile) =>
  file.encoding === "utf16le"
    ? Buffer.from(`﻿${file.content}`, "utf16le")
    : Buffer.from(file.content, "utf8");

function writeServiceFile(file: ServiceFile) {
  mkdirSync(dirname(file.path), { recursive: true });
  writeFileSync(file.path, fileBytes(file), {
    mode: file.secret ? 0o600 : 0o644,
  });
  if (file.secret) restrictToOwner(file.path);
}

async function query(
  resolved: Resolved,
  data: string,
): Promise<ServiceState & { linger: boolean | null }> {
  const { layout, env } = resolved;
  const call = statusQuery(layout);
  const state = parseStatus(
    layout.platform,
    await run(env, call.command, call.args),
  );
  // Windows 的 schtasks 输出随系统语言变，在不在跑按代理登记的 pid 看。
  if (state.running === null) {
    const record = new AgentState(data).pid();
    const alive = record?.service === true && processAlive(record.pid);
    state.running = alive;
    state.pid = alive ? record!.pid : null;
  }
  let linger: boolean | null = null;
  if (layout.platform === "linux") {
    const call = lingerQuery(resolved.user);
    linger = lingerOn(await run(env, call.command, call.args));
  }
  return { ...state, linger };
}

async function stopAgent(data: string) {
  const record = new AgentState(data).pid();
  if (!record?.service || !(await agentAlive(record))) return;
  // 只结束代理这一个进程：执行者各在自己的进程组 / 中转里，照跑。
  try {
    process.kill(record.pid);
  } catch {
    // 已退出。
  }
  for (let i = 0; i < 50 && processAlive(record.pid); i++)
    await new Promise((resolve) => setTimeout(resolve, 100));
}

async function perform(resolved: Resolved, data: string, steps: Step[]) {
  for (const step of steps) {
    if (step.kind === "stop-agent") {
      await stopAgent(data);
      continue;
    }
    let result = await run(resolved.env, step.command, step.args);
    for (
      let attempt = 0;
      !result.ok && attempt < (step.retries ?? 0);
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, resolved.retryMs));
      result = await run(resolved.env, step.command, step.args);
    }
    if (!result.ok && !step.allowFail)
      throw new Problem(
        500,
        `${step.command} ${step.args.join(" ")} 失败：${(result.stderr || result.stdout).trim().slice(0, 500) || "没有输出"}`,
        "service_failed",
      );
  }
}

export type InstallResult = {
  platform: string;
  name: string;
  /** 已装好且定义没变、正在跑：什么也没做。 */
  unchanged: boolean;
  running: boolean;
  pid: number | null;
  /** Linux：linger 没开（也没能开）时开机不会自己起，退出登录会停。 */
  linger: boolean | null;
  lingerHint: string | null;
  log: string;
  locations: string[];
  /** 前台还有代理在跑：服务里的代理等它停下再接手。 */
  foreground: number | null;
};

/** 装成系统服务（重复执行幂等：定义没变又在跑就不动，变了按新定义重起）。 */
export async function installService(
  data: string,
  deps: ServiceDeps = {},
): Promise<InstallResult> {
  const resolved = resolve(data, deps);
  const { layout } = resolved;
  const before = await query(resolved, data);
  const unchanged =
    before.installed && before.running === true && layout.files.every(sameFile);
  if (!unchanged) {
    for (const file of layout.files) writeServiceFile(file);
    await perform(resolved, data, installSteps(layout, before));
  }
  let linger = before.linger;
  let lingerHint: string | null = null;
  if (layout.platform === "linux" && !linger) {
    // 让用户服务开机就起、退出 SSH 也不停；要不到授权就把命令写给用户。
    const enabled = await run(resolved.env, "loginctl", [
      "enable-linger",
      resolved.user,
    ]);
    const call = lingerQuery(resolved.user);
    linger =
      enabled.ok && lingerOn(await run(resolved.env, call.command, call.args));
    if (!linger) lingerHint = `sudo loginctl enable-linger ${resolved.user}`;
  }
  const after = unchanged ? before : await settle(resolved, data);
  const record = new AgentState(data).pid();
  const foreground =
    record && !record.service && (await agentAlive(record)) ? record.pid : null;
  return {
    platform: layout.platform,
    name: layout.name,
    unchanged,
    running: after.running === true,
    pid: after.pid,
    linger,
    lingerHint,
    log: layout.log,
    locations: layout.locations,
    foreground,
  };
}

/** 刚起的服务稍等一下再看状态（最多 3 秒）。 */
async function settle(resolved: Resolved, data: string) {
  let state = await query(resolved, data);
  for (let i = 0; i < 6 && state.running !== true; i++) {
    await new Promise((resolve) => setTimeout(resolve, resolved.retryMs / 2));
    state = await query(resolved, data);
  }
  return state;
}

export type UninstallResult = {
  platform: string;
  name: string;
  /** 本来就没装：什么也没做。 */
  absent: boolean;
  removed: string[];
};

/** 卸载：停服务、删系统里的登记与服务文件；令牌与 service-env.json 留在数据目录，再装不用重新接入。 */
export async function uninstallService(
  data: string,
  deps: ServiceDeps = {},
): Promise<UninstallResult> {
  const resolved = resolve(data, deps);
  const { layout } = resolved;
  const before = await query(resolved, data);
  const files = serviceDefinitionFiles(layout).filter((file) =>
    existsSync(file.path),
  );
  if (!before.installed && !files.length)
    return {
      platform: layout.platform,
      name: layout.name,
      absent: true,
      removed: [],
    };
  await perform(resolved, data, uninstallSteps(layout));
  for (const file of files) rmSync(file.path, { force: true });
  await perform(resolved, data, afterUninstallSteps(layout));
  return {
    platform: layout.platform,
    name: layout.name,
    absent: false,
    removed: files.map((file) => file.path),
  };
}

export type StatusResult = {
  platform: string;
  name: string;
  installed: boolean;
  running: boolean;
  pid: number | null;
  enabled: boolean | null;
  linger: boolean | null;
  /** 服务定义和这次会写的不一样（换了 node、Atrium 装到别处）：重跑 install。 */
  stale: boolean;
  server: string | null;
  host: string | null;
  foreground: number | null;
  log: string;
  tail: string[];
};

/** 日志最后几行（只读末尾 16KB）。 */
function tail(file: string, lines: number) {
  if (!existsSync(file)) return [];
  const size = statSync(file).size;
  const length = Math.min(size, 16 * 1024);
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buffer, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  return buffer
    .toString("utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(-lines);
}

export async function serviceStatus(
  data: string,
  deps: ServiceDeps = {},
): Promise<StatusResult> {
  const resolved = resolve(data, deps);
  const { layout } = resolved;
  const state = await query(resolved, data);
  const agent = new AgentState(data);
  const config = agent.config();
  const record = agent.pid();
  return {
    platform: layout.platform,
    name: layout.name,
    installed: state.installed,
    running: state.running === true,
    pid: state.pid,
    enabled: state.enabled,
    linger: state.linger,
    // 只比服务定义：环境随终端不同，换个终端看状态不算过时。
    stale: state.installed && !serviceDefinitionFiles(layout).every(sameFile),
    server: config?.server ?? null,
    host: config?.host ?? null,
    foreground:
      record && !record.service && (await agentAlive(record))
        ? record.pid
        : null,
    log: layout.log,
    tail: tail(layout.log, 8),
  };
}
