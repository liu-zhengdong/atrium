import { z } from "zod";

export const id = z.string().uuid();
export const chatReference = z
  .union([z.string().regex(/^c[1-9][0-9]{0,14}(?![\s\S])/), id])
  .describe("聊天短号，如 c1；兼容旧 UUID");
export const agentReference = z
  .union([z.string().regex(/^a[1-9][0-9]{0,14}(?![\s\S])/), id])
  .describe("Agent 短号，如 a1；兼容 UUID");
export const text = z.string().trim().min(1).max(6000);
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
export const preferences = z
  .object({
    auto_start: z.boolean().default(false),
    heartbeat_seconds: z.number().int().min(5).max(3600).default(30),
  })
  .strict();
export type Preferences = z.infer<typeof preferences>;
export const defaultPreferences: Preferences = {
  auto_start: false,
  heartbeat_seconds: 30,
};
export const sendInput = z
  .object({
    chat_id: id,
    body: z.string().trim().max(6000).default(""),
    mentions: z.array(id).max(30).default([]),
    client_id: id.optional(),
    attachments: z.array(id).max(10).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.body && value.attachments.length === 0)
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
export type Chat = {
  id: string;
  ref: string;
  name: string;
  kind: "group" | "direct";
  direct_agent: string | null;
  read_only?: boolean;
  /** 用户参与的会话（私聊或发过言的群）；否则为围观。 */
  mine?: boolean;
  /** 用户未读消息数；围观会话用于显示淡点。 */
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
/** 综合搜索：会话（含已隐藏）、消息、Agent。 */
export type SearchResults = {
  chats: Chat[];
  messages: {
    chat_id: string;
    chat_ref: string;
    chat_name: string;
    id: number;
    sender: string;
    sender_name: string;
    text: string;
    created_at: number;
  }[];
  agents: { id: string; ref: string; name: string; description: string }[];
};
export type Message = {
  id: number;
  chat_id: string;
  sender: string;
  sender_name?: string | null;
  sender_deleted_at?: number | null;
  body: string;
  mentions: string[];
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
    unread: number;
  })[];
  chats: Chat[];
  /** Display root of the per-identity desktop directories (home shown as ~). */
  desktops_root: string;
  discovery: {
    runtimes: LiveRuntime[];
    scanning: boolean;
    error: string | null;
  };
};
