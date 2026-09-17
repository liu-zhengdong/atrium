import type { ChatReadState } from "../../shared/schema.ts";

// Read evidence is monotonic. A late, narrower SSE/page response must not erase
// receipts already loaded for older messages in the same conversation.
export function mergeReadState(
  previous: ChatReadState[],
  incoming: ChatReadState[] = [],
): ChatReadState[] {
  return incoming.map((reader) => {
    const old = previous.find((item) => item.agent_id === reader.agent_id);
    const through = Math.max(reader.through, old?.through ?? 0);
    const ranges: ChatReadState["ranges"] = [];
    for (const range of [...(old?.ranges ?? []), ...reader.ranges].sort(
      (a, b) => a.first - b.first,
    )) {
      if (range.last <= through) continue;
      const last = ranges.at(-1);
      if (last && range.first <= last.last + 1)
        last.last = Math.max(last.last, range.last);
      else ranges.push({ ...range });
    }
    return { agent_id: reader.agent_id, through, ranges };
  });
}
