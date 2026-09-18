import { z } from "zod";

export const id = z.string().uuid();
export const chatReference = z
  .union([z.string().regex(/^c[1-9][0-9]{0,14}(?![\s\S])/), id])
  .describe("聊天短号，如 c1；兼容旧 UUID");
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
export const preferences = z
  .object({
    auto_start: z.boolean(),
    wake_interval_seconds: z.number().int().min(30).max(86400),
    message_threshold: z.number().int().min(1).max(10000),
  })
  .strict();
export type Preferences = z.infer<typeof preferences>;
export const defaultPreferences: Preferences = {
  auto_start: false,
  wake_interval_seconds: 300,
  message_threshold: 100,
};
export const sendInput = z
  .object({
    chat_id: id,
    body: text,
    mentions: z.array(id).max(30).default([]),
    client_id: id.optional(),
  })
  .strict();
export const subscriptionInput = z
  .object({
    repository: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/)
      .max(160),
    event: z.enum([
      "pull_request.opened",
      "pull_request.reopened",
      "pull_request.synchronize",
      "pull_request.closed",
    ]),
  })
  .strict();
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
  preview: string | null;
  updated_at: number;
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
};
export type Subscription = {
  id: number;
  agent_id: string;
  repository: string;
  event: string;
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
  discovery: {
    runtimes: LiveRuntime[];
    scanning: boolean;
    error: string | null;
  };
  github_enabled: boolean;
};
