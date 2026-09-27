import { Problem } from "../server/problem.ts";
import { recordNext } from "./contract.ts";
import { printJson, table, when } from "./format.ts";
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
    ["短号", "名称", "状态", "机器", "编码 CLI", "在跑", "自动派哪些仓库"],
    ...hosts.map((view) => [
      view.ref,
      view.name,
      view.status,
      machine(view),
      clisText(view.info?.clis),
      `${view.running}/${view.max ?? "不限"}`,
      reposText(view),
    ]),
  ]);
}

function detail(view: HostView & { tasks?: { ref: string; title: string }[] }) {
  return [
    `${view.ref} ${view.name} · ${view.status}`,
    `机器：${view.info ? `${view.info.hostname} · ${machine(view)} · Node ${view.info.node} · Atrium ${view.info.version}` : "还没上报"}`,
    ...(view.info && view.kind === "remote"
      ? [`代理数据目录：${view.info.data_dir}`]
      : []),
    `编码 CLI：${clisText(view.info?.clis)}`,
    `在跑 ${view.running}/${view.max ?? "不限"}${view.load ? ` · 负载 ${view.load.load}${view.load.busy ? ` · ${view.load.busy}` : ""}` : ""}`,
    `自动派哪些仓库：${reposText(view)}`,
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
    about: "看一台执行机器：系统、编码 CLI、负载、最近心跳、在跑的任务",
    positionals: [1, 1],
    async run({ positionals: [reference], json }) {
      const view = await (
        await client()
      ).get<HostView & { tasks: { ref: string; title: string }[] }>(
        `/hosts/${enc(hostRef(reference))}`,
      );
      if (json) printJson(view);
      else console.log(detail(view));
      recordNext(`派活到这台：atrium task run tN --host ${view.ref}`);
    },
  },
  "host add": {
    args: "名称 [--repo owner/name|*]… [--max 数量]",
    about:
      "登记一台远程执行机器，给出一次性接入码（30 分钟内有效）与在那台机器上要运行的 atrium agent 命令；--repo 登记自动派活时能接的仓库（* 全部；不写只自动接没有仓库的活，--host 指定时不受限），--max 同时最多跑几件（缺省按那台的核数）",
    options: {
      repo: { type: "string", multiple: true },
      max: { type: "string" },
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
      });
      const address = await serviceAddress();
      const command = `atrium agent --server ${address} --token ${result.code}`;
      if (json) printJson({ ...result, command });
      else
        console.log(
          [
            `已登记 ${result.host.ref} ${result.host.name}（待接入；接入码 30 分钟内有效，只能用一次）`,
            "在那台机器上装好 Node 24+ 与 Atrium 后运行：",
            `  ${command}`,
            `服务地址要换成那台机器连得到的：本机服务只听 ${address}，跨机器经 SSH 转发（ssh -R）、内网穿透或 VPN 连过来；OrbStack 虚拟机里用 http://host.orb.internal:${new URL(address).port}`,
          ].join("\n"),
        );
      recordNext(`接入后查看：atrium host show ${result.host.ref}`);
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
  "host pause": {
    args: "hN",
    about: "暂停往这台派新活（在跑的照跑）；本机 h1 也可以暂停，让活只去远程",
    positionals: [1, 1],
    async run({ positionals: [reference], json }) {
      const result = await (
        await client()
      ).post<{ host: HostView }>(`/hosts/${enc(hostRef(reference))}/pause`, {
        paused: true,
      });
      if (json) printJson(result);
      else
        console.log(
          `${result.host.ref} ${result.host.name} 已暂停接活；在跑的照跑`,
        );
      recordNext(`恢复：atrium host resume ${result.host.ref}`);
    },
  },
  "host resume": {
    args: "hN",
    about: "恢复往这台派活；排着的活会按顺序拉起",
    positionals: [1, 1],
    async run({ positionals: [reference], json }) {
      const result = await (
        await client()
      ).post<{ host: HostView }>(`/hosts/${enc(hostRef(reference))}/pause`, {
        paused: false,
      });
      if (json) printJson(result);
      else console.log(`${result.host.ref} ${result.host.name} 已恢复接活`);
      recordNext("看主机：atrium host ls");
    },
  },
};

export const agentCommand: Command = {
  args: "--server <服务地址> [--token <接入码>]",
  about:
    "在远程机器上运行：接入 Atrium 服务并领派给这台的活（前台常驻，Ctrl-C 停；执行者不随它退出，再起来接着看）；首次用 host add 给的接入码，之后只要 --server。数据在 ~/.atrium-agent（ATRIUM_AGENT_DATA 可改）",
  options: {
    server: { type: "string" },
    token: { type: "string" },
  },
  positionals: [0, 0],
  async run({ values }) {
    const server = str(values, "server");
    if (!server)
      throw new Problem(
        400,
        "--server 必填：Atrium 服务的地址，如 http://127.0.0.1:4310（跨机器时是转发或 VPN 后的地址）",
        "usage",
      );
    const { runAgent } = await import("../server/agent/run.ts");
    return runAgent({ server, code: str(values, "token") });
  },
};
