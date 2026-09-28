import { Problem } from "../server/problem.ts";
import { recordNext } from "./contract.ts";
import { defaultActor } from "./worker-guard.ts";
import { oneLine, printJson, table, when } from "./format.ts";
import type { Command, Values } from "./main.ts";

/**
 * 执行机器（#358 第 1 步，atrium host …）：本机是 h1，别的机器装好 Atrium 后用 `atrium agent` 接入。
 * `atrium agent` 在远程机器上前台常驻，不经本机服务（它连的就是远程的服务）。
 */

// 不从 main.ts 取值：测试会先加载本模块，main.ts 再回头引入时会撞上循环初始化。
const str = (values: Values, key: string) => {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
};
const strs = (values: Values, key: string) => {
  const value = values[key];
  if (Array.isArray(value))
    return value.filter((item): item is string => typeof item === "string");
  return typeof value === "string" ? [value] : [];
};
const client = async () => (await import("./service.ts")).connect();
const enc = encodeURIComponent;
/** 以谁的名义（秘书会话带 ATRIUM_AS=secretary），停下的任务在停止事件里记发起者（t239）。 */
const asQuery = () => {
  const who = defaultActor();
  return who ? `?as=${enc(who)}` : "";
};

type Cli = { installed: boolean; logged_in: boolean | null };
type HostView = {
  ref: string;
  name: string;
  kind: "local" | "remote";
  connection: string;
  status: string;
  paused: boolean;
  removed: boolean;
  info: {
    hostname: string;
    os: string;
    arch: string;
    cpus: number;
    mem_mb: number;
    node: string;
    version: string;
    data_dir: string;
    clis: Record<string, Cli>;
  } | null;
  load: { load: number; running: number; busy: string | null } | null;
  repos: string[];
  max: number | null;
  running: number;
  joined_at: number | null;
  last_seen_at: number | null;
  ssh: {
    target: string;
    key: string | null;
    tunnel: string;
    status: string;
    error: string | null;
    agentServer: string;
  } | null;
  checks?: string;
};

const HOST_REF = /^h[1-9][0-9]{0,8}$/;
function hostRef(value: string | undefined) {
  if (!value || !HOST_REF.test(value))
    throw new Problem(
      400,
      `主机应为短号，如 h2（收到：${value ?? ""}）`,
      "usage",
      undefined,
      "atrium host ls",
    );
  return value;
}

/** 编码 CLI 一栏：没判断出是否登录的带问号，确定没登录的写出来。 */
export function clisText(clis: Record<string, Cli> | undefined) {
  const names = Object.entries(clis ?? {})
    .filter(([, cli]) => cli.installed)
    .map(([tool, cli]) =>
      cli.logged_in === false
        ? `${tool}（未登录）`
        : cli.logged_in === null
          ? `${tool}?`
          : tool,
    );
  return names.join(" ") || "（没装）";
}

const machine = (view: HostView) =>
  view.info
    ? `${view.info.os}/${view.info.arch} ${view.info.cpus} 核 ${Math.round(view.info.mem_mb / 1024)}G`
    : "—";

const reposText = (view: HostView) =>
  view.kind === "local"
    ? "全部"
    : view.repos.includes("*")
      ? "全部"
      : view.repos.join(" ") || "只接没有仓库的活（用 --repo 登记）";

export function hostTable(hosts: HostView[]) {
  return table([
    [
      "短号",
      "名称",
      "状态",
      "隧道",
      "机器",
      "编码 CLI",
      "在跑",
      "自动派哪些仓库",
    ],
    ...hosts.map((view) => [
      view.ref,
      view.name,
      view.status,
      view.ssh
        ? oneLine(
            `${view.ssh.status}${view.ssh.error ? ` · ${view.ssh.error}` : ""}`,
            60,
          )
        : "—",
      machine(view),
      clisText(view.info?.clis),
      `${view.running}/${view.max ?? "不限"}`,
      reposText(view),
    ]),
  ]);
}

function detail(
  view: HostView & {
    tasks?: { ref: string; title: string }[];
  },
) {
  return [
    `${view.ref} ${view.name} · ${view.status}`,
    `机器：${view.info ? `${view.info.hostname} · ${machine(view)} · Node ${view.info.node} · Atrium ${view.info.version}` : "还没上报"}`,
    ...(view.info && view.kind === "remote"
      ? [`代理数据目录：${view.info.data_dir}`]
      : []),
    `编码 CLI：${clisText(view.info?.clis)}`,
    `在跑 ${view.running}/${view.max ?? "不限"}${view.load ? ` · 负载 ${view.load.load}${view.load.busy ? ` · ${view.load.busy}` : ""}` : ""}`,
    `自动派哪些仓库：${reposText(view)}`,
    ...(view.ssh
      ? [
          `SSH：${view.ssh.target}${view.ssh.key ? ` · 私钥路径 ${view.ssh.key}` : ""}`,
          `隧道：本机:远端 ${view.ssh.tunnel} · ${view.ssh.status}`,
          `代理服务地址：${view.ssh.agentServer}`,
          ...(view.ssh.error ? [`隧道最近错误：${view.ssh.error}`] : []),
        ]
      : []),
    ...(view.checks ? [`把关检查：${view.checks}`] : []),
    ...(view.last_seen_at ? [`最近心跳：${when(view.last_seen_at)}`] : []),
    ...(view.tasks?.length
      ? [
          "在跑的任务：",
          ...view.tasks.map((task) => `  ${task.ref} ${task.title}`),
        ]
      : []),
  ].join("\n");
}

const serviceAddress = async () => {
  const { servicePort } = await import("../server/service-state.ts");
  return `http://127.0.0.1:${servicePort()}`;
};

export const hostCommands: Record<string, Command> = {
  "host ls": {
    args: "[--all]",
    about:
      "列出执行机器：本机 h1 与接入的远程主机，状态、编码 CLI、在跑几件、自动派哪些仓库；--all 连已移除的",
    options: { all: { type: "boolean" } },
    positionals: [0, 0],
    async run({ values, json }) {
      const result = await (
        await client()
      ).get<{ hosts: HostView[] }>(
        `/hosts${values.all === true ? "?all=1" : ""}`,
      );
      if (json) printJson(result);
      else console.log(hostTable(result.hosts));
      recordNext(
        result.hosts.some((host) => host.kind === "remote")
          ? "派到某台：atrium task run tN --host h2"
          : "接入一台：atrium host add 名称 --repo owner/name",
      );
    },
  },
  "host show": {
    args: "hN",
    about:
      "看一台执行机器：系统、编码 CLI、负载、跑不跑把关检查、最近心跳、在跑的任务",
    positionals: [1, 1],
    async run({ positionals: [reference], json }) {
      const view = await (
        await client()
      ).get<
        HostView & {
          tasks: { ref: string; title: string }[];
        }
      >(`/hosts/${enc(hostRef(reference))}`);
      if (json) printJson(view);
      else console.log(detail(view));
      recordNext(`派活到这台：atrium task run tN --host ${view.ref}`);
    },
  },
  "host add": {
    args: "名称 [--repo owner/name|*]… [--max 数量] [--ssh user@地址] [--key 私钥路径] [--tunnel 本机端口:远端端口]",
    about:
      "登记一台远程执行机器，给出一次性接入码（30 分钟内有效）与在那台机器上要运行的 atrium agent 命令；--repo 登记自动派活时能接的仓库（* 全部；不写只自动接没有仓库的活，--host 指定时不受限），--max 同时最多跑几件（缺省按那台的核数）",
    options: {
      repo: { type: "string", multiple: true },
      max: { type: "string" },
      ssh: { type: "string" },
      key: { type: "string" },
      tunnel: { type: "string" },
    },
    positionals: [1, 1],
    async run({ positionals: [name], values, json }) {
      const maxText = str(values, "max");
      if (maxText !== undefined && !/^[1-9][0-9]?$/.test(maxText))
        throw new Problem(
          400,
          `--max 应为 1 到 64 的整数（收到：${maxText}）`,
          "usage",
        );
      const result = await (
        await client()
      ).post<{ host: HostView; code: string }>("/hosts", {
        name,
        repos: strs(values, "repo"),
        ...(maxText !== undefined ? { max: Number(maxText) } : {}),
        ...(str(values, "ssh") !== undefined
          ? { ssh: str(values, "ssh") }
          : {}),
        ...(str(values, "key") !== undefined
          ? { key: str(values, "key") }
          : {}),
        ...(str(values, "tunnel") !== undefined
          ? { tunnel: str(values, "tunnel") }
          : {}),
      });
      const address = result.host.ssh?.agentServer ?? (await serviceAddress());
      const command = `atrium agent install --server ${address} --token ${result.code}`;
      if (json) printJson({ ...result, command });
      else
        console.log(
          [
            `已登记 ${result.host.ref} ${result.host.name}（待接入；接入码 30 分钟内有效，只能用一次）`,
            "在那台机器上装好 Node 24+ 与 Atrium 后运行（接入并装成系统服务，开机或登录自启、关终端不断）：",
            `  ${command}`,
            "只想在终端前台跑：把 agent install 换成 agent",
            ...(result.host.ssh
              ? [
                  `Atrium 正在管理 ${result.host.ssh.target} 的 SSH 隧道；状态用 atrium host show ${result.host.ref} 查看`,
                ]
              : [
                  `服务地址要换成那台机器连得到的：本机服务只听 ${address}，跨机器经 SSH 转发（ssh -R）、内网穿透或 VPN 连过来；OrbStack 虚拟机里用 http://host.orb.internal:${new URL(address).port}`,
                ]),
          ].join("\n"),
        );
      recordNext(`接入后查看：atrium host show ${result.host.ref}`);
    },
  },
  "host edit": {
    args: "hN [--ssh user@地址] [--key 私钥路径] [--tunnel 本机端口:远端端口]",
    about: "更新远程主机的 SSH 连接和 Atrium 自管隧道；未写的字段沿用原值",
    options: {
      ssh: { type: "string" },
      key: { type: "string" },
      tunnel: { type: "string" },
    },
    positionals: [1, 1],
    async run({ positionals: [reference], values, json }) {
      const body = Object.fromEntries(
        ["ssh", "key", "tunnel"].flatMap((key) => {
          const value = str(values, key);
          return value === undefined ? [] : [[key, value]];
        }),
      );
      if (!Object.keys(body).length)
        throw new Problem(400, "请给出 --ssh、--key 或 --tunnel", "usage");
      const result = await (
        await client()
      ).patch<{ host: HostView }>(`/hosts/${enc(hostRef(reference))}`, body);
      if (json) printJson(result);
      else console.log(detail(result.host));
      recordNext(`查看连接状态：atrium host show ${result.host.ref}`);
    },
  },
  "host remove": {
    args: "hN",
    about:
      "移除远程执行机器：令牌作废，短号保留不复用；上面还有在跑的任务时拒绝",
    positionals: [1, 1],
    async run({ positionals: [reference], json }) {
      const result = await (
        await client()
      ).delete<{ host: HostView }>(`/hosts/${enc(hostRef(reference))}`);
      if (json) printJson(result);
      else
        console.log(
          `已移除 ${result.host.ref} ${result.host.name}；那台机器上的 atrium agent 会因令牌失效退出`,
        );
      recordNext("看剩下的：atrium host ls");
    },
  },
  "host clean": {
    args: "hN",
    about:
      "止损：清理这台上 Atrium 拉起的残留进程——停掉在那台跑的非紧急执行者，再结束最近一天已结束任务仍活着的执行者进程树（远程由那台的代理核对并结束；按命令行与启动时刻核对，不碰你自己开的进程），逐条列出并记进任务事件；常和 pause --host 一起写进紧急任务的 --stopgap",
    positionals: [1, 1],
    async run({ positionals: [reference], json }) {
      const result = await (
        await client()
      ).post<{
        host: HostView;
        detail: string;
        stopped: string[];
        killed: { task: string; pid: number; tool: string }[];
        unreached?: string;
      }>(`/hosts/${enc(hostRef(reference))}/clean${asQuery()}`, {});
      if (json) printJson(result);
      else {
        const lines = [
          `${result.host.ref} 停掉 ${result.stopped.length} 个在跑的执行者${result.stopped.length ? `：${result.stopped.join("、")}` : ""}`,
        ];
        if (result.unreached) lines.push(`残留进程没清：${result.unreached}`);
        else {
          lines.push(`结束 ${result.killed.length} 个残留进程树`);
          for (const kill of result.killed)
            lines.push(`  ${kill.task}  pid ${kill.pid}  ${kill.tool}`);
        }
        console.log(lines.join("\n"));
      }
      recordNext(
        result.unreached
          ? `代理连上后再清：atrium host clean ${result.host.ref}`
          : result.killed.length
            ? `看任务事件：atrium task show ${result.killed[0]!.task}`
            : `看这台：atrium host show ${result.host.ref}`,
      );
    },
  },
};

/** 代理数据目录：--data 优先，其次 ATRIUM_AGENT_DATA，缺省 ~/.atrium-agent。 */
const agentData = async (values: Values) => {
  const { agentDataDir } = await import("../server/agent/state.ts");
  const { resolve } = await import("node:path");
  const given = str(values, "data")?.trim();
  return given ? resolve(given) : agentDataDir();
};

export const agentCommand: Command = {
  args: "[--server <服务地址>] [--token <接入码>] [--data <目录>]",
  about:
    "在远程机器上运行：接入 Atrium 服务并领派给这台的活（前台常驻，Ctrl-C 停；执行者不随它退出，再起来接着看）；首次用 host add 给的接入码，之后只要 --server。想开机自启、关终端不断用 atrium agent install。数据在 ~/.atrium-agent（--data 或 ATRIUM_AGENT_DATA 可改）；--service 由系统服务拉起时用",
  options: {
    server: { type: "string" },
    token: { type: "string" },
    data: { type: "string" },
    service: { type: "boolean" },
  },
  positionals: [0, 0],
  async run({ values }) {
    const { runAgent } = await import("../server/agent/run.ts");
    return runAgent({
      server: str(values, "server"),
      code: str(values, "token"),
      data: await agentData(values),
      service: values.service === true,
    });
  },
};

const SERVICE_KIND: Record<string, string> = {
  darwin: "launchd 用户代理",
  linux: "systemd 用户服务",
  win32: "计划任务",
};
const AUTOSTART: Record<string, string> = {
  darwin: "登录时自启",
  linux: "开机自启（linger）",
  win32: "本人登录时自启",
};

export const agentServiceCommands: Record<string, Command> = {
  "agent install": {
    args: "[--server <服务地址>] [--token <接入码>] [--data <目录>]",
    about:
      "在远程机器上把代理装成系统服务，一条命令完成接入与自启：macOS launchd、Linux systemd 用户服务、Windows 计划任务（登录时启动、隐藏窗口）；异常退出 10 秒后自动重起，关终端不断。首次带 host add 给的接入码，已接入过可省略。重复执行幂等：没变就不动，变了按新定义重起。令牌只在数据目录的 agent.json（0600），服务配置里没有",
    options: {
      server: { type: "string" },
      token: { type: "string" },
      data: { type: "string" },
    },
    positionals: [0, 0],
    async run({ values, json }) {
      const data = await agentData(values);
      const { AgentState } = await import("../server/agent/state.ts");
      const server =
        str(values, "server") ?? new AgentState(data).config()?.server;
      if (!server)
        throw new Problem(
          400,
          "--server 必填：首次接入时使用 host add 回执里的地址；接入后可省略",
          "usage",
        );
      const { Agent } = await import("../server/agent/main.ts");
      const { currentVersion } = await import("../server/service-state.ts");
      // 先在前台用接入码换令牌（服务定义里不带接入码）；已接入过就只核对。
      const agent = new Agent({
        server,
        data,
        env: process.env,
        code: str(values, "token")?.trim() || undefined,
        version: currentVersion(),
        quota: null,
      });
      const host = await agent.enroll();
      const { installService } = await import("../server/agent/service.ts");
      const result = await installService(data);
      const config = new AgentState(data).config();
      if (json)
        printJson({ ...result, host, server: config?.server ?? server });
      else
        console.log(
          [
            `${result.unchanged ? "已装好，没有改动" : "已装成系统服务"}：${SERVICE_KIND[result.platform]} ${result.name}（${host} · 服务 ${config?.server ?? server}）`,
            result.running
              ? `在跑 · PID ${result.pid ?? "?"} · ${AUTOSTART[result.platform]}`
              : `还没在跑：${result.foreground ? "等前台代理停下" : `看日志 ${result.log}`}`,
            ...(result.foreground
              ? [
                  `这台还有前台运行的代理（PID ${result.foreground}）：在那个终端按 Ctrl-C 停掉，服务里的代理 10 秒内接手`,
                ]
              : []),
            ...(result.lingerHint
              ? [
                  `linger 没开：现在只在登录期间运行，退出登录会停；要开机就起运行 ${result.lingerHint}`,
                ]
              : []),
            ...(result.platform === "win32"
              ? ["Windows 上本人登录后才起（锁屏不影响）；注销后不跑"]
              : []),
            "改动的系统位置：",
            ...result.locations.map((location) => `  ${location}`),
            `日志：${result.log}`,
          ].join("\n"),
        );
      recordNext(
        `看状态：atrium agent status${values.data ? ` --data ${data}` : ""}`,
      );
    },
  },
  "agent uninstall": {
    args: "[--data <目录>]",
    about:
      "卸载代理的系统服务：停掉服务里的代理（执行者照跑）、删系统里的登记与服务文件；令牌留在数据目录，再装不用重新接入。没装时什么也不做",
    options: { data: { type: "string" } },
    positionals: [0, 0],
    async run({ values, json }) {
      const data = await agentData(values);
      const { uninstallService } = await import("../server/agent/service.ts");
      const result = await uninstallService(data);
      if (json) printJson(result);
      else
        console.log(
          result.absent
            ? `没装系统服务（${SERVICE_KIND[result.platform]} ${result.name}），不用卸载`
            : [
                `已卸载 ${SERVICE_KIND[result.platform]} ${result.name}；在跑的执行者照跑`,
                ...(result.removed.length
                  ? [
                      "删掉的文件：",
                      ...result.removed.map((file) => `  ${file}`),
                    ]
                  : []),
                `令牌仍在 ${data}；前台运行 atrium agent 或再装 atrium agent install 都不用重新接入`,
              ].join("\n"),
        );
      recordNext(
        `前台运行：atrium agent${values.data ? ` --data ${data}` : ""}`,
      );
    },
  },
  "agent status": {
    args: "[--data <目录>]",
    about:
      "看这台代理的系统服务：装没装、在不在跑、是否自启、接入的服务与短号、服务定义是否过时、日志最后几行",
    options: { data: { type: "string" } },
    positionals: [0, 0],
    async run({ values, json }) {
      const data = await agentData(values);
      const { serviceStatus } = await import("../server/agent/service.ts");
      const result = await serviceStatus(data);
      const suffix = values.data ? ` --data ${data}` : "";
      if (json) printJson(result);
      else
        console.log(
          [
            `系统服务：${SERVICE_KIND[result.platform]} ${result.name} · ${
              result.installed
                ? `${result.running ? `在跑（PID ${result.pid ?? "?"}）` : "没在跑"} · ${result.enabled ? AUTOSTART[result.platform] : "不自启"}`
                : "没装"
            }`,
            ...(result.linger === false && result.installed
              ? ["linger 没开：退出登录会停、开机不会自己起"]
              : []),
            ...(result.stale
              ? [
                  "服务定义和现在的不一致（node 或 Atrium 换了位置）：重跑 atrium agent install",
                ]
              : []),
            `接入：${result.host ? `${result.host} · 服务 ${result.server}` : "还没接入"}`,
            ...(result.foreground
              ? [`前台代理在跑：PID ${result.foreground}`]
              : []),
            `日志：${result.log}`,
            ...result.tail.map((line) => `  ${line}`),
          ].join("\n"),
        );
      recordNext(
        !result.installed
          ? `装成系统服务：atrium agent install${suffix}`
          : result.stale || !result.running
            ? `按现在的定义重装并重起：atrium agent install${suffix}`
            : `卸载：atrium agent uninstall${suffix}`,
      );
    },
  },
};
