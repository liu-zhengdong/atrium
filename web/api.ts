import type { Chat, SearchResults } from "../shared/schema.ts";

export function messageOf(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Error:\s*/, "")
    .replaceAll("provider", "供应商");
}

export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(value.error ?? `请求失败（${response.status}）`);
  return value;
}

/** 综合搜索：会话、消息、Agent。 */
export const searchAll = (q: string) =>
  api<SearchResults>(`/search?q=${encodeURIComponent(q)}`);

/** 会话的显示状态：隐藏（新消息自动顶回）、置顶。 */
export const patchChat = (
  id: string,
  body: { hidden?: boolean; pinned?: boolean },
) => api<Chat>(`/chats/${id}`, "PATCH", body);
