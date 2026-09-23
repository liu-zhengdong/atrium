import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import {
  unreadLabel,
  type Attachment,
  type BoxMessage,
  type Chat,
  type Message,
  type Overview,
  type Page,
  type SearchResults,
} from "../shared/schema.ts";
import { isUserRef, type UserProfile } from "../shared/user.ts";
import { connect, type Client } from "./service.ts";
import { clip, printJson, table, when } from "./format.ts";
import { str, strs, type Command } from "./main.ts";
import { findAgent, roster } from "./agents.ts";

const chatByRef = (view: Overview, reference: string) =>
  view.chats.find((item) => item.ref === reference || item.id === reference);
/** 群名不像身份名那样保证唯一，撞名时不猜，报出各自的短号让用户挑。 */
function chatByName(view: Overview, name: string): Chat | undefined {
  const matches = view.chats.filter((item) => item.name === name);
  if (matches.length > 1)
    throw new Error(
      `有 ${matches.length} 个会话叫 ${name}，请改用短号：${matches.map((item) => item.ref).join("、")}`,
    );
  return matches[0];
}
function findChat(view: Overview, reference: string): Chat {
  const chat = chatByRef(view, reference) ?? chatByName(view, reference);
  if (!chat) throw new Error(`会话不存在：${reference}`);
  return chat;
}
/**
 * 目标写会话（c1 或会话名）就用那个会话；写身份就打开或复用与它的私聊。
 * 身份排在会话名前面：与某个身份的私聊就叫这个身份的名字，而 `--as` 时
 * 要开的是那两位之间的私聊，不是用户与它的那个。
 */
async function targetChat(
  client: Client,
  view: Overview,
  reference: string,
  as?: string,
): Promise<Chat> {
  const byRef = chatByRef(view, reference);
  if (byRef) return byRef;
  const agent = view.agents.find(
    (item) =>
      item.ref === reference ||
      item.name === reference ||
      item.id === reference,
  );
  if (agent)
    return client.post<Chat>(`/agents/${agent.id}/direct`, as ? { as } : {});
  const byName = chatByName(view, reference);
  if (byName) return byName;
  throw new Error(`没有叫 ${reference} 的会话或 Agent`);
}
/** 发送者怎么称呼：用户用资料里的称呼，Agent 用身份名，都带短号。 */
function senderLabel(view: Overview, message: Message) {
  if (isUserRef(message.sender))
    return `${view.user.name || "用户"}(${message.sender})`;
  const ref = view.agents.find((agent) => agent.id === message.sender)?.ref;
  return `${message.sender_name ?? "已删除的身份"}(${ref ?? "已删除"})`;
}
const attachmentLabel = (item: Attachment) =>
  ` [${item.kind === "image" ? "图片" : "文件"} ${item.name}]`;

const chats: Command = {
  args: "",
  about: "会话列表：短号、名称、类型、未读、最近一条",
  positionals: [0, 0],
  async run({ json }) {
    const view = await roster(await connect());
    if (json) return printJson(view.chats);
    if (!view.chats.length)
      return console.log("还没有会话；atrium send 名称 正文 会打开私聊");
    console.log(
      table([
        ["短号", "名称", "类型", "未读", "最近", "预览"],
        ...view.chats.map((chat) => [
          chat.ref,
          chat.name,
          chat.kind === "group" ? "群" : "私聊",
          chat.unread ? unreadLabel(chat.unread) : "",
          when(chat.updated_at),
          clip(chat.preview ?? "", 50),
        ]),
      ]),
    );
  },
};

const read: Command = {
  args: "会话|身份 [--before 序号] [--full]",
  about:
    "读一段消息（用户审阅，不改变 Agent 的已读状态）；详情默认只标字数，--full 显示全文",
  options: {
    before: { type: "string" },
    full: { type: "boolean", default: false },
  },
  positionals: [1, 1],
  async run({ positionals: [reference], values, json }) {
    const client = await connect();
    const view = await roster(client);
    const chat = await targetChat(client, view, reference!);
    const before = str(values, "before");
    const page = await client.get<{ items: Message[]; has_more: boolean }>(
      `/chats/${chat.id}/messages${before ? `?before=${encodeURIComponent(before)}` : ""}`,
    );
    if (json) return printJson({ chat, ...page });
    console.log(
      `${chat.name} · ${chat.ref} · ${chat.kind === "group" ? "群" : "私聊"}${chat.notice ? `\n公告：${chat.notice}` : ""}`,
    );
    if (!page.items.length) return console.log("（还没有消息）");
    for (const message of page.items) {
      const folded =
        message.details && !values.full
          ? `（详情 ${message.details.length} 字）`
          : "";
      console.log(
        `#${message.id}  ${when(message.created_at)}  ${senderLabel(view, message)}：${message.body}${folded}${message.attachments.map(attachmentLabel).join("")}`,
      );
      if (message.details && values.full)
        console.log(`  详情：\n${message.details.replace(/^/gm, "    ")}`);
    }
    if (page.has_more)
      console.log(
        `更早的消息：atrium read ${chat.ref} --before ${page.items[0]!.id}`,
      );
  },
};

const mimeByExtension: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".pdf": "application/pdf",
};
async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
const send: Command = {
  args: "会话|身份 正文 [--details 详情] [--as 身份] [--mention 名称]… [--all] [--file 路径]…",
  about:
    "发言；默认以用户 u1 名义，--as 以某个身份的名义（正文最长 300 字，长内容用 --details）；正文或详情为 - 时读标准输入",
  options: {
    details: { type: "string" },
    as: { type: "string" },
    mention: { type: "string", multiple: true },
    all: { type: "boolean", default: false },
    file: { type: "string", multiple: true },
  },
  positionals: [1, 2],
  async run({ positionals: [reference, text], values }) {
    const body = text === "-" ? (await readStdin()).trim() : (text ?? "");
    const detailsArg = str(values, "details");
    const details =
      detailsArg === "-" ? (await readStdin()).trim() : (detailsArg ?? "");
    const as = str(values, "as");
    const client = await connect();
    const view = await roster(client);
    const chat = await targetChat(client, view, reference!, as);
    const mentions = strs(values, "mention").map(
      (name) => findAgent(view, name).id,
    );
    const attachments: string[] = [];
    for (const path of strs(values, "file")) {
      const bytes = readFileSync(path);
      const staged = await client.upload<Attachment>("/attachments", bytes, {
        "x-filename": encodeURIComponent(basename(path)),
        "x-mime":
          mimeByExtension[extname(path).toLowerCase()] ??
          "application/octet-stream",
      });
      attachments.push(staged.id);
    }
    const message = await client.post<Message>("/messages", {
      chat_id: chat.id,
      body,
      ...(details ? { details } : {}),
      mentions,
      attachments,
      mention_all: values.all === true,
      ...(as ? { as } : {}),
    });
    console.log(`已发送 #${message.id} → ${chat.name}（${chat.ref}）`);
  },
};

const group: Command = {
  args: "群名 成员… [--as 身份] [--note 来意]",
  about: "建群；--as 以某个身份的名义建（它自动入群），--note 写给受邀者的来意",
  options: { as: { type: "string" }, note: { type: "string" } },
  positionals: [2, 31],
  async run({ positionals: [name, ...members], values }) {
    const as = str(values, "as");
    const note = str(values, "note");
    const client = await connect();
    const view = await roster(client);
    const chat = await client.post<Chat>("/chats", {
      name,
      members: members.map((member) => findAgent(view, member).id),
      ...(as ? { as } : {}),
      ...(note ? { note } : {}),
    });
    const detail = await client.get<Chat & { members: string[] }>(
      `/chats/${chat.id}`,
    );
    console.log(
      `已建群 ${chat.name}（${chat.ref}）· 成员 ${detail.members.length} 位`,
    );
  },
};

const invite: Command = {
  args: "会话 名称 [--as 身份] [--note 来意]",
  about:
    "拉一位身份进群；--as 以群内某个身份的名义邀请，--note 写给受邀者的来意",
  options: { as: { type: "string" }, note: { type: "string" } },
  positionals: [2, 2],
  async run({ positionals: [reference, member], values }) {
    const as = str(values, "as");
    const note = str(values, "note");
    const client = await connect();
    const view = await roster(client);
    const chat = findChat(view, reference!);
    const agent = findAgent(view, member!);
    const { members } = await client.post<{ members: string[] }>(
      `/chats/${chat.id}/members`,
      {
        agent_id: agent.id,
        ...(as ? { as } : {}),
        ...(note ? { note } : {}),
      },
    );
    console.log(
      `${agent.name} 已加入 ${chat.name}（${chat.ref}）· 成员 ${members.length} 位`,
    );
  },
};

const kick: Command = {
  args: "会话 名称",
  about: "把一位身份移出群",
  positionals: [2, 2],
  async run({ positionals: [reference, member] }) {
    const client = await connect();
    const view = await roster(client);
    const chat = findChat(view, reference!);
    const agent = findAgent(view, member!);
    const { members } = await client.delete<{ members: string[] }>(
      `/chats/${chat.id}/members/${agent.id}`,
    );
    console.log(
      `${agent.name} 已移出 ${chat.name}（${chat.ref}）· 成员 ${members.length} 位`,
    );
  },
};

const box: Command = {
  args: "名称 [--pending] [--after 序号]",
  about: "看一位身份的消息箱（用户审阅，不改变已读）",
  options: {
    pending: { type: "boolean", default: false },
    after: { type: "string" },
  },
  positionals: [1, 1],
  async run({ positionals: [reference], values, json }) {
    const client = await connect();
    const agent = findAgent(await roster(client), reference!);
    const query = new URLSearchParams({
      pending_only: values.pending === true ? "true" : "false",
      after: str(values, "after") ?? "0",
    });
    const page = await client.get<Page<BoxMessage>>(
      `/agents/${agent.id}/box?${query}`,
    );
    if (json) return printJson(page);
    if (!page.items.length) return console.log(`${agent.name} 的消息箱是空的`);
    for (const item of page.items) {
      const state = item.done_at ? "已完成" : item.read_at ? "已读" : "未读";
      console.log(
        `#${item.id}  ${when(item.created_at)}  [${item.source}]  ${item.title} · ${state}\n    ${clip(item.body, 200)}`,
      );
    }
    if (page.has_more)
      console.log(`更多：atrium box ${agent.ref} --after ${page.next_after}`);
  },
};

const notify: Command = {
  args: "名称 标题 正文",
  about: "往一位身份的消息箱放一条系统通知",
  positionals: [3, 3],
  async run({ positionals: [reference, title, body] }) {
    const client = await connect();
    const agent = findAgent(await roster(client), reference!);
    const { id } = await client.post<{ id: number }>(
      `/agents/${agent.id}/box`,
      {
        title,
        body,
      },
    );
    console.log(`已通知 ${agent.name} · #${id}`);
  },
};

const search: Command = {
  args: "词",
  about: "综合搜索会话、消息与身份",
  positionals: [1, 1],
  async run({ positionals: [query], json }) {
    const client = await connect();
    const [view, result] = await Promise.all([
      roster(client),
      client.get<SearchResults>(`/search?q=${encodeURIComponent(query!)}`),
    ]);
    if (json) return printJson(result);
    const lines: string[] = [];
    if (result.agents.length)
      lines.push(
        "身份：",
        ...result.agents.map(
          (agent) =>
            `  ${agent.ref}  ${agent.name}${agent.description ? `  ${clip(agent.description, 60)}` : ""}`,
        ),
      );
    if (result.chats.length)
      lines.push(
        "会话：",
        ...result.chats.map(
          (chat) =>
            `  ${chat.ref}  ${chat.name}${chat.hidden ? "（已隐藏）" : ""}`,
        ),
      );
    if (result.messages.length)
      lines.push(
        "消息：",
        ...result.messages.map(
          (hit) =>
            `  ${hit.chat_ref} #${hit.id}  ${when(hit.created_at)}  ${isUserRef(hit.sender) ? view.user.name || "用户" : hit.sender_name}：${clip(hit.text, 80)}`,
        ),
      );
    console.log(lines.length ? lines.join("\n") : "没有匹配的内容");
  },
};

const user: Command = {
  args: "[--name 称呼] [--profile 资料]",
  about: "查看或修改用户资料；Agent 只读它",
  options: { name: { type: "string" }, profile: { type: "string" } },
  positionals: [0, 0],
  async run({ values, json }) {
    const client = await connect();
    let me = await client.get<UserProfile>("/user");
    const name = str(values, "name"),
      profile = str(values, "profile");
    if (name !== undefined || profile !== undefined)
      me = await client.patch<UserProfile>("/user", {
        name: name ?? me.name,
        profile: profile ?? me.profile,
      });
    if (json) return printJson(me);
    console.log(
      `${me.id} · 称呼：${me.name || "（未填）"}${me.profile ? `\n资料：${me.profile}` : ""}`,
    );
  },
};

export const chatCommands: Record<string, Command> = {
  chats,
  read,
  send,
  group,
  invite,
  kick,
  box,
  notify,
  search,
  user,
};
