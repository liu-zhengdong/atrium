import type { InboxEvent } from "./events.ts";

/** Event payload for both ACP turns and one-shot resumed turns. */
export function wakePrompt(events: readonly InboxEvent[]): string {
  const ids = events.map((event) => event.id);
  const tasks = [
    ...new Set(events.flatMap((event) => (event.task ? [event.task] : []))),
  ];
  return [
    `【Atrium 事件】${events.length} 条待处理事件已送达（编号 ${ids.join("、")}）：`,
    ...events.map((event) => {
      const detail = (event.detail ?? {}) as Record<string, unknown>;
      const title =
        typeof detail.title === "string" ? detail.title.slice(0, 40) : "";
      const reason =
        typeof detail.reason === "string" ? detail.reason.slice(0, 160) : "";
      const pr =
        typeof detail.pr_url === "string" ? detail.pr_url.slice(0, 500) : "";
      return `- ${[
        `#${event.id}`,
        event.task,
        event.kind,
        title,
        event.count > 1 ? `（合并 ${event.count} 次）` : "",
        pr,
        reason ? `· ${reason}` : "",
      ]
        .filter(Boolean)
        .join(" ")}`;
    }),
    "",
    tasks.length
      ? `看详情：${tasks.map((task) => `atrium task show ${task}`).join("；")}`
      : "看详情：atrium events",
    // 汇报与上交是通用规则（原先写在根章程里）；规矩本身看要点（atrium org show 根部分）。
    "只把要用户拍板的事递给用户（选项单、目标冲突、越过底线或额度、下面搞不定的）；汇报先给结论，按组织树逐层汇总。",
    `处理完确认：atrium events ack ${ids.join(" ")}`,
  ].join("\n");
}
