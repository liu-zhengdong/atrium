import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { AgentInfo, LiveRuntime, Overview } from "../shared/schema.ts";
import { commandAgent } from "../shared/command-agent.ts";
import {
  formatModelSpec,
  groupModelsByProvider,
  modelBase,
  modelSpec,
  type ModelChange,
  type ModelState,
} from "../shared/model.ts";
import type { TraceDetail, TracePage } from "../shared/trace.ts";
import { dataDirectory } from "../server/service-state.ts";
import { requireAssignment } from "../server/assignment.ts";
import { connect, type Client } from "./service.ts";
import { clip, printJson, table, when } from "./format.ts";
import { str, type Command } from "./main.ts";
import { Problem, closest } from "../server/problem.ts";
import { recordNext } from "./contract.ts";
import { waitOptions } from "./wait-options.ts";

export type AgentEntry = Overview["agents"][number];
/** 与 Web 头像状态点同一套判断。 */
export const presence = (
  agent: Pick<AgentEntry, "available" | "runtime" | "failure" | "unassigned"> &
    Partial<Pick<AgentEntry, "sleeping_at" | "waking" | "running">>,
) =>
  agent.unassigned
    ? "未分配账号"
    : agent.waking
      ? "正在唤醒"
      : agent.sleeping_at && agent.failure
        ? "唤醒失败 · 可重试"
        : agent.failure
          ? "出错"
          : agent.sleeping_at && !agent.running
            ? "休息中 · 来消息会醒"
            : agent.runtime?.busy
              ? "干活"
              : agent.available
                ? "在线"
                : "离线";
export const roster = (client: Client) => client.get<Overview>("/overview");
/** 名册里找一位：短号、名称或 ID。接口的路径参数只认 ID，所以先在这里换。 */
export function findAgent(view: Overview, reference: string): AgentEntry {
  const agent = view.agents.find(
    (item) =>
      item.ref === reference ||
      item.name === reference ||
      item.id === reference,
  );
  if (!agent)
    throw new Problem(
      404,
      `没有叫「${reference}」的 Agent`,
      "agent_not_found",
      closest(reference, view.agents),
    );
  return agent;
}

const list: Command = {
  args: "",
  about: "名册：短号、名称、状态、模型、消息箱待处理数、工作声明",
  positionals: [0, 0],
  async run({ json }) {
    const client = await connect();
    const view = await roster(client);
    if (json) return printJson(view.agents);
    if (!view.agents.length)
      return console.log("还没有身份；atrium create 名称");
    // 离线身份没有运行时，模型取配置里写着的；在跑且与配置不同的再注明实际在用。
    const models = await Promise.all(
      view.agents.map((agent) =>
        client
          .get<ModelState>(`/agents/${agent.id}/model`)
          .then(modelCell, () => ""),
      ),
    );
    console.log(
      table([
        ["短号", "名称", "状态", "模型", "消息箱", "工作声明", "错误"],
        ...view.agents.map((agent, index) => [
          agent.ref,
          agent.name,
          presence(agent),
          models[index]!,
          agent.unread ? String(agent.unread) : "",
          clip(agent.work, 40),
          agent.failure
            ? clip(agent.failure.text.replace(/\s+/g, " "), 55)
            : "",
        ]),
      ]),
    );
  },
};

const show: Command = {
  args: "名称",
  about: "身份详情：资料、目录、偏好、模型现状、运行状态",
  positionals: [1, 1],
  async run({ positionals: [reference], json }) {
    const client = await connect();
    const agent = findAgent(await roster(client), reference!);
    const model = await client.get<ModelState>(`/agents/${agent.id}/model`);
    if (json) return printJson({ ...agent, model });
    const running =
      model.running && model.running !== modelBase(model.configured ?? "")
        ? `，运行中实际在用 ${model.running}`
        : "";
    console.log(
      [
        `${agent.name} · ${agent.ref} · ${presence(agent)}`,
        agent.description && `介绍：${agent.description}`,
        agent.work && `工作声明：${agent.work}`,
        `模型：${model.configured ?? "未设定（跟随 pi 默认）"}${running}${model.options.length ? `，可选 ${model.options.length} 个` : ""}`,
        agent.runtime &&
          `运行：${agent.runtime.mode.toUpperCase()} · PID ${agent.runtime.pid}${agent.runtime.busy ? " · 执行中" : ""}`,
        agent.sleeping_at &&
          !agent.running &&
          `休眠起点：${when(agent.sleeping_at)}`,
        `工作目录：${agent.cwd}`,
        `配置目录：${agent.agent_directory ?? "无（旧记录，待升级）"}`,
        agent.session_file && `会话文件：${agent.session_file}`,
        agent.session_reset_at &&
          `会话已于 ${when(agent.session_reset_at)} 重建：${agent.session_reset_reason}`,
        `心跳：每 ${agent.config.heartbeat_seconds} 秒 · 最近一次 ${agent.last_wake ? when(agent.last_wake) : "还没有"}`,
        agent.unread ? `消息箱：${agent.unread} 条待处理` : "",
        agent.failure
          ? `错误（${when(agent.failure.at)}，连续 ${agent.failure.count} 次）：${agent.failure.text}`
          : agent.error && `错误：${agent.error}`,
      ]
        .filter((line): line is string => !!line)
        .join("\n"),
    );
  },
};

const create: Command = {
  args: "名称 [--from 名称] [--description 介绍] [--start]",
  about: "从内置类型或已有身份创建长期身份；须分配账号后启动",
  options: {
    from: { type: "string" },
    description: { type: "string" },
    start: { type: "boolean", default: false },
  },
  positionals: [1, 1],
  async run({ positionals: [name], values }) {
    const client = await connect();
    const frames = ["◐", "◓", "◑", "◒"];
    let frame = 0;
    const progress = process.stderr.isTTY
      ? setInterval(() => {
          process.stderr.write(
            `\r\x1b[2K${frames[frame++ % frames.length]} 正在复制插件…`,
          );
        }, 120)
      : null;
    let result: { agent: AgentEntry; start_error?: string };
    try {
      result = await client.post<typeof result>("/agents", {
        name,
        source: str(values, "from") ?? "builtin",
        description: str(values, "description") ?? "",
        start: values.start === true,
      });
    } finally {
      if (progress) {
        clearInterval(progress);
        process.stderr.write("\r\x1b[2K");
      }
    }
    console.log(`${result.agent.name} · ${result.agent.ref}`);
    recordNext(`查看可用账号：atrium accounts`);
    if (result.start_error) throw new Error(result.start_error);
  },
};

const start: Command = {
  args: "名称",
  about: "后台启动这个身份的 Pi（RPC），接上就投递积压的消息",
  positionals: [1, 1],
  async run({ positionals: [reference] }) {
    const client = await connect();
    const agent = findAgent(await roster(client), reference!);
    await client.post(`/agents/${agent.id}/start`);
    const started = findAgent(await roster(client), agent.id);
    console.log(
      `已启动 ${started.name} · ${presence(started)}${started.runtime ? ` · PID ${started.runtime.pid} · ${started.runtime.model}` : ""}`,
    );
    recordNext(`发私聊：atrium send ${started.ref} 正文`);
  },
};

const newSession: Command = {
  args: "名称 [--timeout 秒]",
  about: "等当前回合结束后为身份开启新 Pi 会话；旧会话文件保留",
  options: { timeout: { type: "string" } },
  positionals: [1, 1],
  async run({ positionals: [reference], values }) {
    const seconds = waitOptions(undefined, str(values, "timeout")).seconds;
    const client = await connect();
    const agent = findAgent(await roster(client), reference!);
    const result = await client
      .post<{
        old_session_file: string | null;
        new_session_file: string | null;
      }>(`/agents/${agent.id}/new-session`, { timeout: seconds })
      .catch((error: unknown) => {
        if (error instanceof Problem && error.code === "timeout")
          throw new Problem(
            408,
            error.message,
            "timeout",
            undefined,
            `atrium new-session ${agent.ref} --timeout ${Math.min(3600, Math.max(300, seconds * 2))}`,
          );
        throw error;
      });
    console.log(
      `已为 ${agent.name} 开启新会话：${result.new_session_file ?? "会话文件待生成"}\n旧会话文件保留：${result.old_session_file ?? "此前没有会话文件"}`,
    );
    recordNext(`查看轨迹：atrium trace ${agent.ref}`);
  },
};

const retry: Command = {
  args: "名称",
  about: "重试上一轮出错的 Agent",
  positionals: [1, 1],
  async run({ positionals: [reference] }) {
    const client = await connect();
    const agent = findAgent(await roster(client), reference!);
    await client.post(`/agents/${agent.id}/retry`);
    console.log(`已重试 ${agent.name}`);
  },
};

const stop: Command = {
  args: "名称",
  about: "停止 Atrium 启动的托管实例；会话与待投递消息保留",
  positionals: [1, 1],
  async run({ positionals: [reference] }) {
    const client = await connect();
    const agent = findAgent(await roster(client), reference!);
    await client.post(`/agents/${agent.id}/stop`);
    console.log(`已停止 ${agent.name}；被私聊或 @ 时会再起来`);
  },
};

const remove: Command = {
  args: "名称 --yes",
  about: "删除身份：撤销访问与后续唤醒，历史与本地文件保留",
  options: { yes: { type: "boolean", default: false } },
  positionals: [1, 1],
  async run({ positionals: [reference], values }) {
    const client = await connect();
    const agent = findAgent(await roster(client), reference!);
    if (values.yes !== true) {
      const target = commandAgent(agent.name, agent.ref);
      const status = agent.running
        ? presence(agent)
        : agent.unassigned
          ? "未分配账号"
          : "离线";
      const message = `将删除 ${agent.name}（${agent.ref}，${status}）：撤销访问与后续唤醒，历史聊天保留。`;
      const stop = agent.running ? `atrium stop ${target}` : null;
      throw new Problem(
        400,
        `${message}\n${stop ? `先停止：${stop}\n` : ""}确认删除：atrium delete ${target} --yes`,
        "confirmation_required",
        undefined,
        stop ?? undefined,
      );
    }
    await client.delete(`/agents/${agent.id}`, { confirm: agent.ref });
    console.log(`已删除 ${agent.name}（${agent.ref}）；历史保留`);
  },
};

const config: Command = {
  args: "名称 [--heartbeat 秒]",
  about: "查看或修改消息箱心跳间隔",
  options: { heartbeat: { type: "string" } },
  positionals: [1, 1],
  async run({ positionals: [reference], values, json }) {
    const heartbeat = str(values, "heartbeat");
    if (
      heartbeat !== undefined &&
      (!/^\d+$/.test(heartbeat.trim()) ||
        Number(heartbeat) < 5 ||
        Number(heartbeat) > 3600)
    )
      throw new Problem(
        400,
        "--heartbeat 要填秒数（5～3600 的整数）\n示例：atrium config 甲 --heartbeat 30",
        "usage",
      );
    const client = await connect();
    let agent = findAgent(await roster(client), reference!);
    if (heartbeat !== undefined) {
      await client.patch(`/agents/${agent.id}/config`, {
        heartbeat_seconds: Number(heartbeat),
      });
      agent = findAgent(await roster(client), agent.id);
    }
    if (json) return printJson(agent.config);
    console.log(`${agent.name} · 心跳 ${agent.config.heartbeat_seconds} 秒`);
  },
};

const profile: Command = {
  args: "名称 [--name 新名称] [--description 介绍]",
  about: "查看或修改身份资料",
  options: { name: { type: "string" }, description: { type: "string" } },
  positionals: [1, 1],
  async run({ positionals: [reference], values, json }) {
    const client = await connect();
    let agent = findAgent(await roster(client), reference!);
    const name = str(values, "name"),
      description = str(values, "description");
    if (name !== undefined || description !== undefined) {
      // 接口整体替换两个字段，没给的沿用当前值。
      await client.patch(`/agents/${agent.id}/profile`, {
        name: name ?? agent.name,
        description: description ?? agent.description,
      });
      agent = findAgent(await roster(client), agent.id);
    }
    if (json)
      return printJson({
        id: agent.id,
        ref: agent.ref,
        name: agent.name,
        description: agent.description,
      });
    console.log(
      `${agent.name} · ${agent.ref}${agent.description ? `\n介绍：${agent.description}` : ""}`,
    );
  },
};

function modelCell(state: ModelState) {
  const configured = state.configured ?? "";
  return state.running && state.running !== modelBase(configured)
    ? `${state.running}（配置 ${configured || "未设定"}）`
    : configured;
}

function modelReport(name: string, state: ModelState, notes: string[] = []) {
  return [
    `${name} · ${state.configured ?? "未设定（跟随 pi 默认）"}`,
    ...(state.running &&
    state.running !== (state.configured && modelBase(state.configured))
      ? [`运行中实际在用：${state.running}`]
      : []),
    ...notes.map((note) => `注意：${note}`),
    // 一个 provider 一行：几百个模型逐行铺开没法看。
    ...(state.options.length
      ? [
          "可选（provider: 模型）：",
          ...[
            ...groupModelsByProvider(state.options.map((option) => option.id)),
          ].map(([provider, models]) => `  ${provider}: ${models.join(" ")}`),
        ]
      : ["还没取到过这个身份的可选模型，启动它之后再看这里就有了。"]),
  ].join("\n");
}

const model: Command = {
  args: "名称 [provider/id[:思考强度]]",
  about: "查看或设定模型；在跑的身份当场生效，离线的下次启动生效",
  positionals: [1, 2],
  async run({ positionals: [reference, value], json }) {
    if (value !== undefined && !modelSpec.safeParse(value).success)
      throw new Problem(
        400,
        "模型写法是 provider/id，可选 :思考强度\n示例：atrium model 甲 deepseek/deepseek-v4-pro",
        "usage",
      );
    const client = await connect();
    const agent = findAgent(await roster(client), reference!);
    const path = `/agents/${agent.id}/model`;
    if (value === undefined) {
      const state = await client.get<ModelState>(path);
      return json
        ? printJson(state)
        : console.log(modelReport(agent.name, state));
    }
    const { notes, ...state } = await client.put<ModelChange>(path, {
      model: value,
    });
    return json
      ? printJson({ ...state, notes })
      : console.log(modelReport(agent.name, state, notes));
  },
};

const traceState: Record<string, string> = {
  running: "进行中",
  complete: "完成",
  error: "出错",
  unknown: "未知",
};
const trace: Command = {
  args: "名称 [--before 序号] [--show 序号]",
  about: "运行轨迹：真实的工具调用与消息；--show 看某一条的参数与结果",
  options: { before: { type: "string" }, show: { type: "string" } },
  positionals: [1, 1],
  async run({ positionals: [reference], values, json }) {
    const client = await connect();
    const agent = findAgent(await roster(client), reference!);
    const show = str(values, "show");
    if (show !== undefined) {
      const detail = await client.get<TraceDetail>(
        `/agents/${agent.id}/trace/${encodeURIComponent(show)}`,
      );
      if (json) return printJson(detail);
      console.log(
        [
          `#${detail.id} · ${when(detail.at)} · ${detail.kind}${detail.name ? ` ${detail.name}` : ""} · ${traceState[detail.state] ?? detail.state}`,
          detail.title,
          detail.input && `--- 参数 ---\n${detail.input}`,
          detail.output && `--- 结果 ---\n${detail.output}`,
          detail.truncated && "（正文已截断）",
        ]
          .filter(Boolean)
          .join("\n"),
      );
      return;
    }
    const before = str(values, "before");
    const page = await client.get<TracePage>(
      `/agents/${agent.id}/trace${before ? `?before=${encodeURIComponent(before)}` : ""}`,
    );
    if (json) return printJson(page);
    if (page.error) console.log(`注意：${page.error}`);
    if (!page.items.length) return console.log("还没有轨迹记录");
    console.log(
      table(
        page.items.map((item) => [
          `#${item.id}`,
          when(item.at),
          `${item.kind}${item.name ? ` ${item.name}` : ""}`,
          clip(item.title, 80),
          traceState[item.state] ?? item.state,
        ]),
      ),
    );
    if (page.has_more)
      console.log(
        `更早的：atrium trace ${agent.ref} --before ${page.items[page.items.length - 1]!.id}`,
      );
  },
};

const runtimes: Command = {
  args: "",
  about: "本机发现的 Pi 实例（含未绑定身份的），供 attach 使用",
  positionals: [0, 0],
  async run({ json }) {
    const client = await connect();
    const [view, { runtimes: live }] = await Promise.all([
      roster(client),
      client.get<{ runtimes: LiveRuntime[] }>("/runtimes"),
    ]);
    if (json) return printJson(live);
    if (!live.length) return console.log("没有发现运行中的 Pi 实例");
    console.log(
      table([
        ["实例", "PID", "模式", "身份", "工作目录"],
        ...live.map((runtime) => [
          runtime.runtimeId,
          String(runtime.pid),
          runtime.mode.toUpperCase(),
          runtime.bound_agent
            ? (view.agents.find((agent) => agent.id === runtime.bound_agent)
                ?.name ?? runtime.bound_agent)
            : "",
          runtime.cwd,
        ]),
      ]),
    );
  },
};

const attach: Command = {
  args: "名称 实例ID",
  about: "把发现的 Pi 实例接到这个身份上",
  positionals: [2, 2],
  async run({ positionals: [reference, runtimeId] }) {
    const client = await connect();
    const agent = findAgent(await roster(client), reference!);
    await client.post(`/agents/${agent.id}/attach`, { runtime_id: runtimeId });
    console.log(`已把实例 ${runtimeId} 接到 ${agent.name}`);
  },
};

const promote: Command = {
  args: "名称 [--template 目录]",
  about: "把旧记录升级为有自己配置目录的长期身份",
  options: { template: { type: "string" } },
  positionals: [1, 1],
  async run({ positionals: [reference], values }) {
    const client = await connect();
    const agent = findAgent(await roster(client), reference!);
    const template = str(values, "template");
    const upgraded = await client.post<AgentInfo>(
      `/agents/${agent.id}/promote`,
      template ? { template } : {},
    );
    console.log(
      `已升级 ${upgraded.name} · 配置目录 ${upgraded.agent_directory}`,
    );
  },
};

const require = createRequire(import.meta.url);
const run: Command = {
  args: "名称",
  about: "用长期身份打开原生 Pi TUI；不经过服务",
  positionals: [1, 1],
  async run({ positionals: [reference], json }) {
    if (json) throw new Problem(400, "交互式 run 不支持 --json", "usage");
    const data = dataDirectory();
    if (!existsSync(join(data, "atrium.sqlite")))
      throw new Error(
        "未找到 Atrium 数据库；请先运行 atrium create 或打开 Web 创建身份，或设置 ATRIUM_DATA",
      );
    const { Store } = await import("../server/store.ts");
    const store = new Store(join(data, "atrium.sqlite"));
    let agent: AgentInfo;
    try {
      agent = store.agent(store.resolveAgentId(reference!));
      requireAssignment(store, agent.id);
    } finally {
      store.close();
    }
    if (!agent.agent_directory)
      throw new Error("旧记录尚未升级；请先 atrium promote 名称，历史会保留");
    const { runNamedTui } = require("@liuser/pi-atrium/dist/identity.js") as {
      runNamedTui(value: {
        identityId: string;
        agentDirectory: string;
        cwd: string;
        sessionFile?: string;
        model?: string;
      }): Promise<number>;
    };
    const { readIdentityModel, syncIdentityProfile } =
      await import("../server/profile.ts");
    // 与服务启动身份时做同一份补齐，两个入口看到的配置一致。
    for (const notice of syncIdentityProfile(agent.agent_directory))
      console.error(`${agent.name} 的${notice}`);
    console.error(`Atrium · ${agent.name}\n${agent.cwd}`);
    const launchStore = new Store(join(data, "atrium.sqlite"));
    let running: Promise<number>;
    try {
      // 启动放在事务里，pi-atrium 的占用登记与数据库里的绑定一起落定。
      running = launchStore.transaction(() => {
        const current = launchStore.agent(agent.id);
        requireAssignment(launchStore, current.id);
        // 恢复的会话自带模型记录，会盖过配置默认值；只有启动参数压得住它。
        const configured = readIdentityModel(current.agent_directory!);
        return runNamedTui({
          identityId: current.id,
          agentDirectory: current.agent_directory!,
          cwd: current.cwd,
          ...(current.session_file
            ? { sessionFile: current.session_file }
            : {}),
          ...(configured ? { model: formatModelSpec(configured) } : {}),
        });
      });
    } finally {
      launchStore.close();
    }
    return running;
  },
};

export const agentCommands: Record<string, Command> = {
  list,
  show,
  create,
  start,
  "new-session": newSession,
  retry,
  stop,
  delete: remove,
  config,
  profile,
  model,
  trace,
  run,
  runtimes,
  attach,
  promote,
};
