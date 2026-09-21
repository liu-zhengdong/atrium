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

/** 同一个人三分钟内的后续发言合并显示：不重复头像和标题行，间距收窄。 */
export function continuationFlags(messages: Message[]): boolean[] {
  return messages.map((message, index) => {
    const previous = messages[index - 1];
    return (
      previous !== undefined &&
      previous.sender === message.sender &&
      message.created_at - previous.created_at < 180000
    );
  });
}
