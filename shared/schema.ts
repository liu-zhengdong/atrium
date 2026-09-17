import { z } from "zod";

export const id = z.string().uuid();
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
export const delivery = z
  .object({
    id,
    session_id: z.string().min(1),
    kind: z.enum(["direct", "summary"]),
    text: z.string().min(1).max(30000),
  })
  .strict();
export const linkFile = z
  .object({
    url: z.string().url(),
    agent_id: id,
    token: z.string().min(32).max(128),
  })
  .strict();
export type Link = z.infer<typeof linkFile>;
export type AgentInfo = {
  id: string;
  name: string;
  work: string;
  config: Preferences;
  cwd: string;
  session_file: string | null;
};
export type RuntimeInfo = {
  pid: number;
  session_id: string;
  session_file: string | null;
  cwd: string;
  mode: string;
  busy: boolean;
  model: string;
};
export type Chat = {
  id: string;
  name: string;
  kind: "group" | "direct";
  direct_agent: string | null;
  preview: string | null;
  updated_at: number;
};
export type Message = {
  id: number;
  chat_id: string;
  sender: string;
  body: string;
  mentions: string[];
  created_at: number;
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
    error: string | null;
    unread: number;
  })[];
  chats: Chat[];
  github_enabled: boolean;
};
