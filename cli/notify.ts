import { Problem } from "../server/problem.ts";
import { recordNext } from "./contract.ts";
import { printJson, when } from "./format.ts";
import { longWait } from "./long-wait.ts";
import type { Command, Values } from "./main.ts";

/**
 * 推送到手机（atrium notify）：用户自己在 @BotFather 建机器人，token 从标准输入交给服务存进
 * Atrium 自己的凭据文件（0600），再给机器人发绑定码绑定聊天。只推等你拍板、上交到你这层的卡住／越界、
 * 里程碑上线（含运行时到期代为上交的卡住），只带标题和短号；选项单卡片上点按钮拍板、回复卡片附说明。
 */

const client = async () => (await import("./service.ts")).connect();
const str = (values: Values, key: string) => {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
};

type Status = {
  configured: boolean;
  bot: string | null;
  bound: boolean;
  enabled: boolean;
  quiet: string;
  batch_seconds: number;
  proxy: string | null;
  system_proxy: string | null;
  pending: number;
  last_sent_at: number | null;
  last_error: { error: string; at: number } | null;
  bind: BindHint | null;
};
type BindHint = { code: string; link: string | null; expires_at: number };
type Bound = BindHint & {
  bound: boolean;
  timed_out: boolean;
  restarting?: boolean;
  bot?: string;
  kept?: boolean;
};

const TOKEN_MAX = 4 * 1024;
const PIPE_HINT =
  "pbpaste | atrium notify --token（Windows：Get-Clipboard | atrium notify --token）";
const TOKEN_NEXT = "存 token：pbpaste | atrium notify --token";

/** 从标准输入读 token：终端里直接敲会回显在屏幕上，只收管道或重定向。 */
async function readToken(stdin: NodeJS.ReadStream = process.stdin) {
  if (stdin.isTTY)
    throw new Problem(
      400,
      `bot token 从标准输入读，不在命令行参数里给（免得进 shell 历史）：${PIPE_HINT}`,
      "usage",
    );
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > TOKEN_MAX)
      throw new Problem(
        400,
        "标准输入太长：只放 @BotFather 给的那一行 token",
        "usage",
      );
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8").replace(/^﻿/, "").trim();
}

const bindLines = (bot: string | null, hint: BindHint) => [
  hint.link
    ? `在手机上打开 ${hint.link} 点「开始」，或给 @${bot} 发：${hint.code}`
    : `给你的机器人发：${hint.code}`,
  `绑定码 ${when(hint.expires_at)} 前有效`,
];

export function statusText(s: Status): string {
  if (!s.configured)
    return `还没配推送到手机。先在 Telegram 找 @BotFather 建一个机器人，再把 token 传进来：${PIPE_HINT}`;
  const lines = [
    `Telegram 机器人 @${s.bot} · ${s.bound ? "已绑定" : "还没绑定聊天"} · ${s.enabled ? "推送开着" : "推送关了"}`,
    `免打扰：${s.quiet === "off" ? "没设" : s.quiet} · 攒批 ${s.batch_seconds} 秒`,
    `代理：${s.proxy ? `${s.proxy}（Atrium 单独配的）` : s.system_proxy ? `${s.system_proxy}（系统代理）` : "直连"}`,
    `待发 ${s.pending} 件${s.last_sent_at ? ` · 最近发出 ${when(s.last_sent_at)}` : ""}`,
  ];
  if (s.last_error)
    lines.push(`最近失败（${when(s.last_error.at)}）：${s.last_error.error}`);
  if (!s.bound && s.bind) lines.push(...bindLines(s.bot, s.bind));
  return lines.join("\n");
}

/** --token：从标准输入读 @BotFather 给的 bot token，核对后存进 Atrium 自己的凭据文件（0600），给出绑定码。 */
async function saveToken(json: boolean) {
  const token = await readToken();
  const result = await (
    await client()
  ).put<BindHint & { bot: string }>("/notify/telegram/token", { token });
  if (json) printJson(result);
  else
    console.log(
      [
        `已存 bot token（@${result.bot}），凭据文件只留给本人`,
        ...bindLines(result.bot, result),
      ].join("\n"),
    );
  recordNext("atrium notify --bind");
}

/** --bind：等你给机器人发绑定码，收到就绑定这个私聊；没收到退出码 124。 */
async function bind(values: Values, json: boolean) {
  const raw = str(values, "timeout");
  if (raw !== undefined && (!/^(0|[1-9]\d*)$/.test(raw) || Number(raw) > 3600))
    throw new Problem(400, "--timeout 应为 0～3600 的整数秒", "usage");
  const seconds = raw === undefined ? 120 : Number(raw);
  const api = await client();
  const result = await longWait<Bound>(
    seconds,
    (timeout) => api.post("/notify/telegram/bind", { timeout }),
    () => "atrium notify --bind",
  );
  if (json) printJson(result);
  else if (result.bound)
    console.log(`已绑定 @${result.bot}，机器人已回了一条「已绑定」`);
  else {
    console.log(bindLines(result.bot ?? null, result).join("\n"));
    console.log(
      `${seconds} 秒内没收到绑定码；发了之后再等：atrium notify --bind`,
    );
  }
  recordNext(result.bound ? "atrium notify --test" : "atrium notify --bind");
  return result.bound ? 0 : 124;
}

/** --test：立刻发一条测试消息（不攒批、不看免打扰）。 */
async function test(json: boolean) {
  const result = await (
    await client()
  ).post<{ sent: boolean; bot: string }>("/notify/telegram/test", {});
  if (json) printJson(result);
  else console.log(`已发测试消息（@${result.bot}），去手机上看看`);
  recordNext("atrium notify");
}

/** --remove：删掉存的 bot token 与绑定（免打扰等设置保留），待发的清空。 */
async function remove(json: boolean) {
  const result = await (
    await client()
  ).delete<{ removed: boolean }>("/notify/telegram");
  if (json) printJson(result);
  else
    console.log(result.removed ? "已删掉 bot token 与绑定" : "本来就没配推送");
  recordNext(TOKEN_NEXT);
}

export const notifyCommands: Record<string, Command> = {
  notify: {
    args: "[--token | --bind [--timeout 秒] | --test | --remove]",
    about:
      "推送到手机（Telegram）：不带选项看状态（机器人、是否绑定、免打扰、攒批、代理、待发与最近一次失败；不显示 token）；--token 从标准输入读 @BotFather 给的 bot token（如 pbpaste | atrium notify --token），存进 Atrium 自己的凭据文件（0600）并给出绑定码，换 token 要重新绑定；--bind 等你给机器人发绑定码（缺省等 120 秒，最多 3600），没收到退出码 124；--test 立刻发一条测试消息；--remove 删掉 bot token 与绑定、清空待发（机器人本身到 @BotFather 删）",
    options: {
      token: { type: "boolean" },
      bind: { type: "boolean" },
      timeout: { type: "string" },
      test: { type: "boolean" },
      remove: { type: "boolean" },
    },
    positionals: [0, 0],
    async run({ values, json }) {
      const picked = (["token", "bind", "test", "remove"] as const).filter(
        (flag) => values[flag] === true,
      );
      if (picked.length > 1)
        throw new Problem(
          400,
          "--token、--bind、--test、--remove 一次只能给一个",
          "usage",
        );
      if (picked[0] === "token") return saveToken(json);
      if (picked[0] === "bind") return bind(values, json);
      if (picked[0] === "test") return test(json);
      if (picked[0] === "remove") return remove(json);
      const status = await (await client()).get<Status>("/notify/telegram");
      if (json) printJson(status);
      else console.log(statusText(status));
      recordNext(
        !status.configured
          ? TOKEN_NEXT
          : !status.bound
            ? "atrium notify --bind"
            : "atrium notify --test",
      );
    },
  },
  "notify set": {
    args: "[--quiet 23:00-08:00|off] [--batch 秒] [--proxy http://主机:端口|off] [--on|--off]",
    about:
      "改推送设置：免打扰时段（本机钟点，期间攒着、结束后合成一条发）、攒批窗口（缺省 60 秒内多条合一条）、单独的 HTTP 代理（不配就走系统 HTTPS_PROXY）、开关（关掉清空待发）",
    options: {
      quiet: { type: "string" },
      batch: { type: "string" },
      proxy: { type: "string" },
      on: { type: "boolean" },
      off: { type: "boolean" },
    },
    positionals: [0, 0],
    async run({ values, json }) {
      if (values.on === true && values.off === true)
        throw new Problem(400, "--on 和 --off 只能给一个", "usage");
      const body: Record<string, unknown> = {};
      if (str(values, "quiet") !== undefined) body.quiet = str(values, "quiet");
      if (str(values, "batch") !== undefined)
        body.batch_seconds = str(values, "batch");
      if (str(values, "proxy") !== undefined) body.proxy = str(values, "proxy");
      if (values.on === true) body.enabled = true;
      if (values.off === true) body.enabled = false;
      const status = await (
        await client()
      ).patch<Status>("/notify/telegram", body);
      if (json) printJson(status);
      else console.log(`已改\n${statusText(status)}`);
      recordNext(status.bound ? "atrium notify --test" : "atrium notify");
    },
  },
};
