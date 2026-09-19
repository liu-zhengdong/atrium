import type { Message } from "../../shared/schema.ts";

/** Merge paginated history and live refreshes without duplicates or cross-chat rows. */
export function mergeMessages(
  current: Message[],
  incoming: Message[],
  chatId: string,
): Message[] {
  return [
    ...new Map(
      [...current, ...incoming]
        .filter((message) => message.chat_id === chatId)
        .map((message) => [message.id, message]),
    ).values(),
  ].sort((a, b) => a.id - b.id);
}
