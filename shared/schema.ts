import { z } from "zod";
import type { UserProfile } from "./user.ts";

export const id = z.string().uuid();
export const chatReference = z
  .union([z.string().regex(/^c[1-9][0-9]{0,14}(?![\s\S])/), id])
  .describe("聊天短号，如 c1；兼容旧 UUID");
export const agentReference = z
  .union([z.string().regex(/^a[1-9][0-9]{0,14}(?![\s\S])/), id])
  .describe("Agent 短号，如 a1；兼容 UUID");
export const text = z.string().trim().min(1).max(6000);
/** 拉人进群时写的来意，随邀请通知送到受邀者面前；是聊天内容，不是指令。 */
export const inviteNote = z.string().trim().max(500).default("");
export const displayName = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(
    /^[\p{L}\p{N}_. -]+$/u,
    "名称只使用文字、数字、空格、点、下划线和连字符",
  );
export const forkSource = z.union([
  z.literal("builtin"),
  agentReference,
  displayName,
]);
const preferenceFields = {
  heartbeat_seconds: z.number().int().min(5).max(3600),
};
/** 读存储的配置：缺的键补默认值。 */
export const preferences = z
  .object({
    heartbeat_seconds: preferenceFields.heartbeat_seconds.default(30),
  })
  .strict();
/**
 * 改配置：只改给了的键。不能拿 `preferences.partial()` 代替：
 * zod 4 对带默认值的字段做 partial 仍会填默认值，没传的键会被默认值盖掉。
 */
export const preferencePatch = z.object(preferenceFields).partial().strict();
export type Preferences = z.infer<typeof preferences>;
export const defaultPreferences: Preferences = {
  heartbeat_seconds: 30,
};
/** Agent 发言的 body 上限：只写回复或结论，长内容放 details。用户发言不受此限。 */
export const AGENT_BODY_MAX = 300;
export const DETAILS_MAX = 6000;
export const DETAILS_NEED_BODY =
  "有 details 时 body 不能为空：用一两句写明回复或结论。";
export const sendInput = z
  .object({
    chat_id: id,
    body: z.string().trim().max(6000).default(""),
    /** 报告、证据、日志等长内容；界面和 read_chat 默认折叠，投递给点名对象时带全文。 */
    details: z.string().trim().max(DETAILS_MAX).default(""),
    mentions: z.array(id).max(30).default([]),
    client_id: id.optional(),
    attachments: z.array(id).max(10).default([]),
    /** @ 全体：只有用户能用，投递给群内每位成员。 */
    mention_all: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.details && !value.body)
      ctx.addIssue({
        code: "custom",
        message: DETAILS_NEED_BODY,
        path: ["body"],
      });
    else if (!value.body && value.attachments.length === 0)
      ctx.addIssue({
        code: "custom",
        message: "请输入内容或添加附件",
        path: ["body"],
      });
  });
export type Attachment = {
  id: string;
  kind: "image" | "file";
  name: string;
  mime: string;
  size: number;
};
export type AgentInfo = {
  id: string;
  ref: string;
  name: string;
  description: string;
  agent_directory: string | null;
  work: string;
  config: Preferences;
  cwd: string;
  session_file: string | null;
  session_reset_at: number | null;
  session_reset_reason: string | null;
  last_wake: number;
};
export const runtimeSchema = z
  .object({
    runtimeId: id,
    generation: id,
    sessionId: id,
    pid: z.number().int().positive(),
    ownerPid: z.number().int().positive().nullable(),
    identityId: id.nullable().optional(),
    sessionFile: z.string().nullable(),
    cwd: z.string(),
    mode: z.enum(["tui", "rpc"]),
    busy: z.boolean(),
    model: z.string(),
  })
  .strict();
export type RuntimeInfo = z.infer<typeof runtimeSchema>;
export const liveRuntimeSchema = runtimeSchema
  .pick({
    runtimeId: true,
    identityId: true,
    generation: true,
    sessionId: true,
    pid: true,
    mode: true,
    cwd: true,
  })
  .strip();
export type LiveRuntime = z.infer<typeof liveRuntimeSchema> & {
  bound_agent?: string | null;
};
/**
 * 未读计数封顶。超过 99 之后精确数字不改变任何判断（用户只需要知道「很多」，
 * Agent 照样一页页读到底），封顶换来计数代价与历史规模无关。
 */
export const UNREAD_CAP = 99;
/** 徽标与提示文案；UNREAD_CAP+1 表示「及以上」。 */
export const unreadLabel = (count: number) =>
  count > UNREAD_CAP ? `${UNREAD_CAP}+` : String(count);
export type Chat = {
  id: string;
  ref: string;
  name: string;
  kind: "group" | "direct";
  /** 群公告，由用户维护；空串表示没有公告。 */
  notice: string;
  direct_agent: string | null;
  read_only?: boolean;
  /** 用户参与的会话（私聊或发过言的群）；否则为围观。 */
  mine?: boolean;
  /** 用户未读消息数，封顶 UNREAD_CAP+1；围观会话用于显示淡点。 */
  unread?: number;
  /** 前几位成员名字，用于合成会话头像。 */
  member_names?: string[];
  /** 用户置顶，排在列表前面。 */
  pinned?: boolean;
  /** 用户已隐藏；只会在搜索结果里为 true。新消息会自动顶回。 */
  hidden?: boolean;
  preview: string | null;
  updated_at: number;
};
/** 一条命中的消息：带上所属会话，因为结果可能跨会话。 */
export type MessageHit = {
  chat_id: string;
  chat_ref: string;
  chat_name: string;
  id: number;
  sender: string;
  sender_name: string;
  text: string;
  created_at: number;
};
/** 综合搜索：会话（含已隐藏）、消息、Agent。 */
export type SearchResults = {
  chats: Chat[];
  messages: MessageHit[];
  agents: { id: string; ref: string; name: string; description: string }[];
};
/** 聊天记录里的一个附件。cursor 是翻页游标，按它倒序。 */
export type FileRecord = {
  id: string;
  chat_id: string;
  chat_ref: string;
  chat_name: string;
  message_id: number;
  kind: "image" | "file";
  name: string;
  mime: string;
  size: number;
  created_at: number;
  uploader: string;
  uploader_name: string;
  cursor: number;
};
/** 倒序翻页的一页：游标在每条自己身上（消息用 id，附件用 cursor）。 */
export type RecordPage<T> = { items: T[]; has_more: boolean };
export type Message = {
  id: number;
  chat_id: string;
  sender: string;
  sender_name?: string | null;
  sender_deleted_at?: number | null;
  body: string;
  /** 折叠显示的详细内容；没有时为空字符串。 */
  details: string;
  mentions: string[];
  /** 这条是 @ 全体，收件人是发送时的全体群成员。 */
  mention_all: boolean;
  created_at: number;
  attachments: Attachment[];
};
export type ChatReadState = {
  agent_id: string;
  through: number;
  name?: string;
  deleted_at?: number | null;
  deleted_after?: number | null;
  ranges: { first: number; last: number }[];
};
export type BoxMessage = {
  id: number;
  agent_id: string;
  source: string;
  title: string;
  body: string;
  chat_id: string | null;
  url: string | null;
  created_at: number;
  read_at: number | null;
  done_at: number | null;
};
export type Page<T> = { items: T[]; next_after: number; has_more: boolean };
export type Overview = {
  agents: (AgentInfo & {
    runtime: RuntimeInfo | null;
    available: boolean;
    error: string | null;
    failure: { text: string; at: number; count: number } | null;
    unread: number;
  })[];
  chats: Chat[];
  /** 本机用户的资料；界面用它认出自己的消息，并提供编辑入口。 */
  user: UserProfile;
  /** Display root of the per-identity desktop directories (home shown as ~). */
  desktops_root: string;
  discovery: {
    runtimes: LiveRuntime[];
    scanning: boolean;
    error: string | null;
  };
};
