import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Problem } from "../server/problem.ts";
import { dataDirectory, alive } from "../server/service-state.ts";
import { messagingEndpoint } from "../server/platform/plan.ts";
import {
  bridgeClaim,
  REMIND_MS,
} from "../server/tasks/secretary/bridge-plan.ts";
import type { Listener } from "../server/tasks/events/events.ts";
import { recordNext } from "./contract.ts";
import { printJson, when } from "./format.ts";
import type { Command, Values } from "./main.ts";

/**
 * `atrium secretary bridge`（t243）：把秘书要处理的事件注入 Claude Code 秘书会话（原生界面不变）。
 * 常驻循环在 `secretary-bridge.ts`（按需加载），判定在 `server/tasks/secretary/bridge-plan.ts`。
 */

const str = (values: Values, key: string) => {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
};

/** SessionStart hook 里跑的命令：后台起 bridge 后立即返回。 */
export const BRIDGE_HOOK_COMMAND = "atrium secretary bridge --detach";

const hookEntry = () => ({
  hooks: [{ type: "command", command: BRIDGE_HOOK_COMMAND, timeout: 30 }],
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * 在 Claude Code 设置里加一条 SessionStart hook（不改原对象）；已有起 bridge 的 hook 就不加。
 * 设置的结构认不出（hooks 不是对象、SessionStart 不是数组）时报错，不覆盖用户的内容。
 */
export function withBridgeHook(settings: unknown): {
  settings: Record<string, unknown>;
  added: boolean;
} {
  if (settings !== undefined && !isObject(settings))
    throw new Problem(409, "设置文件顶层不是 JSON 对象，没有改动", "conflict");
  const base = settings ?? {};
  if (base.hooks !== undefined && !isObject(base.hooks))
    throw new Problem(409, "设置里的 hooks 不是对象，没有改动", "conflict");
  const hooks = (base.hooks as Record<string, unknown> | undefined) ?? {};
  const start = hooks.SessionStart;
  if (start !== undefined && !Array.isArray(start))
    throw new Problem(
      409,
      "设置里的 hooks.SessionStart 不是数组，没有改动",
      "conflict",
    );
  const groups = (start as unknown[] | undefined) ?? [];
  const present = groups.some(
    (group) =>
      isObject(group) &&
      Array.isArray(group.hooks) &&
      group.hooks.some(
        (hook: unknown) =>
          isObject(hook) &&
          typeof hook.command === "string" &&
          hook.command.includes("atrium secretary bridge"),
      ),
  );
  if (present) return { settings: base, added: false };
  return {
    settings: {
      ...base,
      hooks: { ...hooks, SessionStart: [...groups, hookEntry()] },
    },
    added: true,
  };
}

/** 本会话的收件地址与口令：只在 Claude Code 会话的 hook 与 Bash 子进程里有。 */
export function sessionInbox(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.CLAUDE_CODE_MESSAGING_SOCKET;
  const token = env.CLAUDE_CODE_MESSAGING_TOKEN?.trim();
  if (!raw?.trim() || !token)
    throw new Problem(
      400,
      "不在 Claude Code 会话里：没有 CLAUDE_CODE_MESSAGING_SOCKET 与 CLAUDE_CODE_MESSAGING_TOKEN（需要 Claude Code v2.1.224 及以上，Windows v2.1.234 及以上；在秘书会话的 Bash 或 SessionStart hook 里运行）",
      "usage",
    );
  const endpoint = messagingEndpoint(process.platform, raw);
  if (!endpoint)
    throw new Problem(
      400,
      `CLAUDE_CODE_MESSAGING_SOCKET 认不出：${raw.slice(0, 200)}`,
      "usage",
    );
  return { endpoint, token };
}

function remindMs(values: Values) {
  const text = str(values, "remind");
  if (text === undefined) return REMIND_MS;
  if (!/^[1-9]\d*$/.test(text) || Number(text) > 1440)
    throw new Problem(
      400,
      `--remind 应为 1～1440 的整数分钟（收到：${text}）`,
      "usage",
    );
  return Number(text) * 60_000;
}

async function installHook(values: Values, json: boolean) {
  const dir = resolve(str(values, "cwd") ?? process.cwd());
  const file = join(dir, ".claude", "settings.local.json");
  let text: string | undefined;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    text = undefined;
  }
  let current: unknown;
  if (text !== undefined && text.trim()) {
    try {
      current = JSON.parse(text);
    } catch {
      throw new Problem(
        409,
        `${file} 不是合法的 JSON，没有改动；手动在 hooks.SessionStart 里加入：${JSON.stringify(hookEntry())}`,
        "conflict",
      );
    }
  }
  const { settings, added } = withBridgeHook(current);
  if (json) printJson({ file, added, hook: hookEntry() });
  if (!added) {
    if (!json)
      console.log(`${file} 里已有起 bridge 的 SessionStart hook，没有改动`);
    recordNext("看在不在听：atrium secretary bridge --status");
    return;
  }
  if (!json)
    console.log(
      [
        `将写入 ${file}（hooks.SessionStart 加一条，其余设置不动）：`,
        JSON.stringify(hookEntry(), null, 2),
      ].join("\n"),
    );
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  if (!json)
    console.log(
      `已写入。之后在 ${dir} 打开或接着的 Claude Code 会话都会在后台起 bridge；当前会话要马上生效，在会话里运行 ${BRIDGE_HOOK_COMMAND}`,
    );
  recordNext("看在不在听：atrium secretary bridge --status");
}

async function status(json: boolean) {
  const data = dataDirectory();
  const { readBridge } = await import("./secretary-bridge.ts");
  const record = readBridge(data);
  const running = record && alive(record.pid) ? record : null;
  const api = await (await import("./service.ts")).connect();
  const { listener } = await api.get<{ listener: Listener | null }>(
    "/events/listen?as=secretary",
  );
  if (json) printJson({ listener, bridge: running });
  else if (listener)
    console.log(
      `秘书在听（${listener.via}）· 自 ${when(listener.since)}${running ? ` · bridge pid ${running.pid}` : ""}`,
    );
  else
    console.log(
      running
        ? `bridge 在跑（pid ${running.pid}），但还没向服务报「在听」；看日志：${join(data, "secretary", "bridge.log")}`
        : "没有 bridge 在听：Claude Code 秘书会话收不到注入的事件",
    );
  recordNext(
    listener
      ? "看待处理事件：atrium events"
      : "在秘书目录装 hook：atrium secretary bridge --install-hook",
  );
}

/** 后台起 bridge（SessionStart hook 用）：本会话的已在跑就不再起；输出会进会话上下文，写短。 */
async function detach(values: Values) {
  const { endpoint } = sessionInbox();
  const data = dataDirectory();
  const bridge = await import("./secretary-bridge.ts");
  const current = bridge.readBridge(data);
  if (bridgeClaim(current, endpoint, alive) === "running") {
    console.log(
      `Atrium bridge 已在跑（pid ${current!.pid}）：要处理的事件以「【Atrium 事件】」消息送进本会话，处理完 atrium events ack <编号>`,
    );
    recordNext("看在不在听：atrium secretary bridge --status");
    return;
  }
  const { spawnNode } = await import("../server/platform/index.ts");
  mkdirSync(join(data, "secretary"), { recursive: true, mode: 0o700 });
  const logPath = bridge.bridgeLog(data);
  const log = openSync(logPath, "a", 0o600);
  let child;
  try {
    const remind = str(values, "remind");
    child = spawnNode(
      [
        ...process.execArgv,
        process.argv[1]!,
        "secretary",
        "bridge",
        ...(remind === undefined ? [] : ["--remind", remind]),
      ],
      { detached: true, stdio: ["ignore", log, log], env: process.env },
    );
  } finally {
    closeSync(log);
  }
  let exited: number | null = null;
  child.once("exit", (code) => (exited = code ?? 1));
  child.once("error", () => (exited = 1));
  child.unref();
  // 等它登记上（最多 10 秒）：起不来就当场说，不让 hook 静默失败。
  const deadline = Date.now() + 10_000;
  while (
    exited === null &&
    bridge.readBridge(data)?.pid !== child.pid &&
    Date.now() < deadline
  )
    await new Promise((resolve) => setTimeout(resolve, 100));
  if (exited !== null || bridge.readBridge(data)?.pid !== child.pid)
    throw new Problem(
      500,
      `bridge 没起来${exited !== null ? `（退出码 ${exited}）` : ""}；看日志：${logPath}`,
      "internal",
    );
  console.log(
    `Atrium bridge 已在后台运行（pid ${child.pid}）：秘书要处理的事件会以「【Atrium 事件】」开头的消息送进本会话，处理完用 atrium events ack <编号> 确认。日志：${logPath}`,
  );
  recordNext("看在不在听：atrium secretary bridge --status");
}

/** 前台常驻：会话没了、被别的会话接手或收到结束信号才返回。 */
async function foreground(values: Values) {
  const remind = remindMs(values);
  const { endpoint, token } = sessionInbox();
  const data = dataDirectory();
  const bridge = await import("./secretary-bridge.ts");
  const current = bridge.readBridge(data);
  if (
    current?.pid !== process.pid &&
    bridgeClaim(current, endpoint, alive) === "running"
  )
    throw new Problem(
      409,
      `本会话的 bridge 已在跑（pid ${current!.pid}）`,
      "conflict",
      undefined,
      "atrium secretary bridge --status",
    );
  bridge.writeBridge(data, {
    pid: process.pid,
    socket: endpoint,
    started_at: Date.now(),
  });
  const log = (line: string) =>
    console.error(`[${new Date().toISOString()}] ${line}`);
  const loop = new bridge.SecretaryBridge({
    endpoint,
    token,
    remindMs: remind,
    source: bridge.serviceSource(
      await (await import("./service.ts")).connect(true),
    ),
    owner: () => {
      const record = bridge.readBridge(data);
      return !record || record.pid === process.pid;
    },
    log,
  });
  const stop = () => loop.close();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  log(`bridge 开始（pid ${process.pid}，会话收件地址 ${endpoint}）`);
  try {
    log(`bridge 退出：${await loop.run()}`);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    bridge.releaseBridge(data, process.pid);
  }
  recordNext("看在不在听：atrium secretary bridge --status");
}

const bridgeCommand: Command = {
  args: "[--detach] [--remind 分钟] | --install-hook [--cwd 目录] | --status",
  about:
    "在 Claude Code 秘书会话里常驻：把要处理的事件经会话收件 socket 注入会话（不确认，秘书处理完自己 ack），按编号去重、没确认的隔 30 分钟再提醒；会话关了就退出；--install-hook 在秘书目录装 SessionStart hook 随会话自动起",
  options: {
    detach: { type: "boolean", default: false },
    remind: { type: "string" },
    "install-hook": { type: "boolean", default: false },
    cwd: { type: "string" },
    status: { type: "boolean", default: false },
  },
  positionals: [0, 0],
  async run({ values, json }) {
    const modes = ["detach", "install-hook", "status"].filter(
      (key) => values[key] === true,
    );
    if (modes.length > 1)
      throw new Problem(400, `--${modes.join("、--")} 不能一起用`, "usage");
    if (values.cwd !== undefined && values["install-hook"] !== true)
      throw new Problem(400, "--cwd 只和 --install-hook 一起用", "usage");
    if (values["install-hook"] === true) return installHook(values, json);
    if (values.status === true) return status(json);
    remindMs(values);
    if (values.detach === true) return detach(values);
    return foreground(values);
  },
};

export const secretaryCommands: Record<string, Command> = {
  "secretary bridge": bridgeCommand,
};
