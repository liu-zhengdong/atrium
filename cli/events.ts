import { Problem } from "../server/problem.ts";
import type { InboxEvent } from "../server/tasks/events.ts";
import { recordNext } from "./contract.ts";
import { clip, printJson, when } from "./format.ts";
import { longWait, waitSeconds } from "./long-wait.ts";
import type { Command, Values } from "./main.ts";

/** 事件投递的命令行（#262）：订阅者挂着 wait 取一批事件，处理完 ack；ack 前重启也不丢。 */

const str = (values: Values, key: string) => {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
};
const client = async () => (await import("./service.ts")).connect();

function line(event: InboxEvent) {
  const detail = (event.detail ?? {}) as Record<string, unknown>;
  const reason = typeof detail.reason === "string" ? detail.reason : "";
  const title = typeof detail.title === "string" ? detail.title : "";
  return [
    `#${event.id}`,
    event.task ?? "",
    event.kind,
    title ? clip(title, 40) : "",
    event.count > 1 ? `（合并 ${event.count} 次）` : "",
    typeof detail.pr_url === "string" ? detail.pr_url : "",
    reason ? `· ${clip(reason, 160)}` : "",
    `· ${when(event.updated_at)}`,
  ]
    .filter(Boolean)
    .join(" ");
}

const wait: Command = {
  args: "[--as 订阅者] [--timeout 秒]",
  about:
    "取未确认的事件（任务完成、失败、受阻、卡死、CI）；没有就等，有就打印一批退出；取走的 15 分钟内不重投；缺省订阅者 secretary",
  options: { as: { type: "string" }, timeout: { type: "string" } },
  positionals: [0, 0],
  async run({ values, json }) {
    const who = str(values, "as") ?? "secretary";
    if (!who.trim()) throw new Problem(400, "--as 不能为空", "usage");
    const seconds = waitSeconds(str(values, "timeout"));
    const api = await client();
    const query = (timeout: number) =>
      new URLSearchParams({ as: who, timeout: String(timeout) });
    const result = await longWait<{
      events: InboxEvent[];
      timed_out: boolean;
      restarting?: boolean;
    }>(
      seconds,
      (timeout) => api.get(`/events/wait?${query(timeout)}`),
      () => `atrium events wait --as ${who}`,
    );
    const ids = result.events.map((event) => event.id);
    recordNext(
      ids.length
        ? `处理完确认：atrium events ack ${ids.join(" ")}`
        : `继续等：atrium events wait --as ${who}`,
    );
    if (json) printJson(result);
    else if (!ids.length)
      console.log(
        `${seconds} 秒内 ${who} 没有新事件；atrium events wait --as ${who}`,
      );
    else console.log(result.events.map(line).join("\n"));
    return ids.length ? 0 : 124;
  },
};

const ack: Command = {
  args: "编号…",
  about:
    "确认事件已处理（编号见 events wait）；确认后不再投递，未确认的处理中租约到期后重投",
  positionals: [1, 500],
  async run({ positionals, json }) {
    const ids = positionals.map((value) => {
      const text = value.replace(/^#/, "");
      if (!/^[1-9]\d*$/.test(text))
        throw new Problem(
          400,
          `事件编号应为正整数（收到：${value}）`,
          "usage",
          undefined,
          "atrium events wait",
        );
      return Number(text);
    });
    const result = await (
      await client()
    ).post<{ acked: number[]; missing: number[] }>("/events/ack", { ids });
    if (json) printJson(result);
    else
      console.log(
        [
          result.acked.length
            ? `已确认 ${result.acked.map((id) => `#${id}`).join(" ")}`
            : "",
          result.missing.length
            ? `不存在或早已确认：${result.missing.map((id) => `#${id}`).join(" ")}`
            : "",
        ]
          .filter(Boolean)
          .join("；"),
      );
    recordNext("等下一批：atrium events wait");
  },
};

export const eventCommands: Record<string, Command> = {
  "events wait": wait,
  "events ack": ack,
};
