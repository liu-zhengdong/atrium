import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { Problem, closest } from "../server/problem.ts";
import { dataDirectory } from "../server/service-state.ts";
import type { InboxEvent } from "../server/tasks/events.ts";
import {
  AcpConnection,
  agentEnvironment,
  type PermissionOutcome,
  type PermissionRequest,
} from "./acp.ts";
import { recordNext } from "./contract.ts";
import { eventLine } from "./events.ts";
import { clip } from "./format.ts";
import type { Command, Values } from "./main.ts";
import {
  SecretaryChat,
  type ChatView,
  type SessionStore,
} from "./secretary-chat.ts";

/**
 * `atrium chat`：和秘书对话的统一入口（#307）。按秘书所用工具选打开方式：
 * 已接入 ACP 的工具由 Atrium 自己的对话界面驱动（本步：opencode 原生 `opencode acp`）；
 * opencode 原生界面（serve + attach）与其余工具在后续步骤接入。
 */

type ChatMode =
  | { kind: "acp"; command: string; args: string[] }
  | { kind: "planned"; note: string };

export const CHAT_TOOLS: Record<string, ChatMode> = {
  opencode: { kind: "acp", command: "opencode", args: ["acp"] },
  kimi: { kind: "planned", note: "原生 kimi acp，后续接入" },
  codex: { kind: "planned", note: "经 codex-acp 适配器，后续接入" },
  claude: { kind: "planned", note: "经 claude-code-acp 适配器，后续接入" },
};

const SUBSCRIBER = "secretary";

const str = (values: Values, key: string) => {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
};

/** 选工具：--tool，其次 ATRIUM_SECRETARY_TOOL，缺省 opencode。 */
export function chatMode(tool: string) {
  const mode = CHAT_TOOLS[tool];
  if (!mode) {
    const candidate = closest(
      tool,
      Object.keys(CHAT_TOOLS).map((ref) => ({ ref, name: ref })),
    )[0];
    throw new Problem(
      400,
      `--tool 不认识：${tool}；可选 ${Object.keys(CHAT_TOOLS).join("、")}`,
      "usage",
      undefined,
      candidate ? `atrium chat --tool ${candidate.ref}` : undefined,
    );
  }
  if (mode.kind === "planned")
    throw new Problem(
      409,
      `${tool} 做秘书的对话尚未接入（${mode.note}）；现在可用：atrium chat --tool opencode`,
      "conflict",
      undefined,
      "atrium chat --tool opencode",
    );
  return mode;
}

/** 秘书会话编号存在数据目录，下次打开接着上次。 */
export function sessionStore(data: string, tool: string): SessionStore {
  const file = join(data, "secretary", `${tool}-acp.json`);
  return {
    load() {
      try {
        const value = JSON.parse(readFileSync(file, "utf8")) as {
          sessionId?: unknown;
        };
        return typeof value.sessionId === "string" && value.sessionId
          ? value.sessionId
          : undefined;
      } catch {
        return undefined;
      }
    },
    save(sessionId) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(
        file,
        `${JSON.stringify({ sessionId, updated_at: Date.now() })}\n`,
        { mode: 0o600 },
      );
    },
  };
}

const STATUS: Record<string, string> = {
  pending: "开始",
  in_progress: "进行中",
  completed: "完成",
  failed: "失败",
};

/** 终端界面：流式打印回复，事件送入与工具调用单独成行。 */
function terminalView(options: {
  tty: boolean;
  allow: boolean;
  ask: (question: string) => Promise<string>;
  prompt: () => void;
}): ChatView {
  let fresh = true;
  const write = (text: string) => {
    if (!text) return;
    process.stdout.write(text);
    fresh = text.endsWith("\n");
  };
  const block = (text: string) => write(`${fresh ? "" : "\n"}${text}\n`);
  const dim = (text: string) => (options.tty ? `\x1b[2m${text}\x1b[22m` : text);
  return {
    text: write,
    thought(chunk) {
      if (options.tty) write(dim(chunk));
    },
    tool(title, status) {
      if (status === "pending" || status === "completed" || status === "failed")
        block(
          dim(
            `  · ${clip(title.split("\n", 1)[0]!, 100)}（${STATUS[status]}）`,
          ),
        );
    },
    wake(events: InboxEvent[]) {
      block(
        [
          `── 送入事件 ${events.map((event) => `#${event.id}`).join(" ")} ──`,
          ...events.map((event) => `  ${eventLine(event)}`),
        ].join("\n"),
      );
    },
    notice(message) {
      block(`[atrium] ${message}`);
    },
    turnEnd(stopReason) {
      if (stopReason === "cancelled") block("（本轮已取消）");
      else if (stopReason !== "end_turn" && stopReason !== "failed")
        block(`（本轮结束：${stopReason}）`);
      else if (!fresh) write("\n");
      options.prompt();
    },
    async permission(request: PermissionRequest): Promise<PermissionOutcome> {
      const title = request.toolCall.title ?? "工具调用";
      const pick = (kind: string) =>
        request.options.find((option) => option.kind === kind);
      if (options.allow || !options.tty) {
        const option = options.allow
          ? pick("allow_once")
          : (pick("reject_once") ?? pick("reject_always"));
        block(
          `[atrium] 权限请求「${title}」：${option ? option.name : "取消"}（${options.allow ? "--allow 自动允许一次" : "非交互，自动拒绝；需要时加 --allow"}）`,
        );
        return option
          ? { outcome: "selected", optionId: option.optionId }
          : { outcome: "cancelled" };
      }
      block(
        [
          `[atrium] 权限请求：${title}`,
          ...request.options.map(
            (option, index) => `  ${index + 1}. ${option.name}`,
          ),
        ].join("\n"),
      );
      const answer = (await options.ask("选择编号（回车拒绝）：")).trim();
      const chosen = request.options[Number(answer) - 1];
      if (chosen) return { outcome: "selected", optionId: chosen.optionId };
      const reject = pick("reject_once") ?? pick("reject_always");
      return reject
        ? { outcome: "selected", optionId: reject.optionId }
        : { outcome: "cancelled" };
    },
  };
}

export const chatCommand: Command = {
  args: "[--tool opencode] [--cwd 目录] [--new] [--allow]",
  about:
    "和秘书对话；秘书空闲时自动送入待处理事件并标出，忙时排队、一轮结束后合并送入；缺省接着上次的会话",
  options: {
    tool: { type: "string" },
    cwd: { type: "string" },
    new: { type: "boolean", default: false },
    allow: { type: "boolean", default: false },
  },
  positionals: [0, 0],
  async run({ values }) {
    const tool =
      str(values, "tool") ?? process.env.ATRIUM_SECRETARY_TOOL ?? "opencode";
    const mode = chatMode(tool);
    const cwd = resolve(str(values, "cwd") ?? process.cwd());
    const api = await (await import("./service.ts")).connect();
    const data = dataDirectory();
    const tty = process.stdin.isTTY === true && process.stdout.isTTY === true;
    // 会话建好后再建 readline：启动期间的输入留在 stdin 缓冲里，不会在挂上监听前被读走。
    let rl: Interface | undefined;
    const view = terminalView({
      tty,
      allow: values.allow === true,
      ask: (question) =>
        new Promise((resolve) =>
          rl ? rl.question(question, resolve) : resolve(""),
        ),
      prompt: () => {
        if (tty) rl?.prompt(true);
      },
    });
    let chat: SecretaryChat | undefined;
    const connection = new AcpConnection(
      mode.command,
      mode.args,
      { cwd, env: agentEnvironment() },
      {
        update: (sessionId, update) => chat?.update(sessionId, update),
        permission: (request) => view.permission(request),
        exit: (reason) => chat?.exit(reason),
      },
    );
    const cleanup = () => connection.close();
    process.once("exit", cleanup);
    chat = new SecretaryChat({
      connection,
      view,
      cwd,
      fresh: values.new === true,
      store: sessionStore(data, tool),
      source: {
        peek: async (timeout, signal) =>
          (
            await api.get<{ events: InboxEvent[] }>(
              `/events/wait?${new URLSearchParams({ as: SUBSCRIBER, peek: "1", timeout: String(timeout) })}`,
              undefined,
              signal,
            )
          ).events,
        deliver: async (ids) =>
          (
            await api.post<{ events: InboxEvent[] }>(
              `/events/deliver?as=${SUBSCRIBER}`,
              { ids },
            )
          ).events,
      },
    });
    try {
      const init = await connection.request<{
        agentCapabilities?: { loadSession?: boolean };
      }>("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "atrium", version: "1" },
      });
      const { resumed } = await chat.start({
        loadSession: init.agentCapabilities?.loadSession === true,
      });
      console.error(
        `秘书会话（${tool} · ACP · ${resumed ? "接着上次" : "新会话"} ${chat.session}）；待处理事件在秘书空闲时自动送入。Ctrl-C 取消本轮，空闲时 Ctrl-C 或 /exit 退出`,
      );
    } catch (error) {
      connection.close();
      throw new Problem(
        503,
        `秘书会话启动失败（${mode.command} ${mode.args.join(" ")}）：${error instanceof Error ? error.message : String(error)}`,
        "internal",
      );
    }
    rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: tty,
    });
    rl.setPrompt("你> ");
    const interrupt = () => {
      if (chat.cancel()) view.notice("已请求取消本轮");
      else chat.close();
    };
    rl.on("SIGINT", interrupt);
    if (!tty) process.on("SIGINT", interrupt);
    rl.on("line", (line) => {
      const text = line.trim();
      if (!text) return view.turnEnd("end_turn");
      if (text === "/exit" || text === "/quit") return chat.close();
      if (chat.running) view.notice("秘书正在处理，这条排在本轮之后");
      chat.say(text);
    });
    rl.on("close", () => chat.end());
    view.turnEnd("end_turn");
    const reason = await chat.run();
    rl.close();
    connection.close();
    process.off("exit", cleanup);
    process.off("SIGINT", interrupt);
    recordNext("再次打开：atrium chat");
    if (reason)
      throw new Problem(500, `秘书进程意外结束：${reason}`, "internal");
  },
};
