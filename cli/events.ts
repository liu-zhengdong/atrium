import { Problem } from "../server/problem.ts";
import type { InboxEvent } from "../server/tasks/events/events.ts";
import { recordNext } from "./contract.ts";
import { defaultSubscriber } from "./worker-guard.ts";
import { clip, printJson, when } from "./format.ts";
import { longWait, waitSeconds } from "./long-wait.ts";
import type { Command } from "./main.ts";
import { str } from "./args.ts";

/** 事件投递的命令行（#262）：订阅者挂着 wait 取一批事件，处理完 ack；ack 前重启也不丢。 */

const client = async () => (await import("./service.ts")).connect();

export function eventLine(event: InboxEvent) {
  const detail = (event.detail ?? {}) as Record<string, unknown>;
  const reason =
    typeof detail.message === "string"
      ? detail.message
      : typeof detail.reason === "string"
        ? detail.reason
        : "";
  const title = typeof detail.title === "string" ? detail.title : "";
  const line = [
    `#${event.id}`,
    event.task ?? "",
    event.kind,
    title ? clip(title, 40) : "",
    event.count > 1 ? `（合并 ${event.count} 次）` : "",
    event.delivered_at !== null ? "已送达" : "未送达",
    event.acked_at !== null ? "已确认" : "未确认",
    typeof detail.pr_url === "string" ? detail.pr_url : "",
    reason ? `· ${clip(reason, 160)}` : "",
    // 下层上交经上层转交：逐层附上「谁看过、一句意见」。
    ...(Array.isArray(detail.forwarded) ? detail.forwarded : []).flatMap(
      (f: { by?: unknown; note?: unknown }) =>
        typeof f?.by === "string" && typeof f?.note === "string"
          ? [`· ${f.by} 转交：${clip(f.note, 160)}`]
          : [],
    ),
    `· ${when(event.updated_at)}`,
  ]
    .filter(Boolean)
    .join(" ");
  return line;
}

const list: Command = {
  args: "[--as 订阅者] [--before 编号] [--limit 条数]",
  about: "查看事件的送达与确认状态，缺省显示 secretary 最近 50 条",
  options: {
    as: { type: "string" },
    before: { type: "string" },
    limit: { type: "string" },
  },
  positionals: [0, 0],
  async run({ values, json }) {
    const who = str(values, "as") ?? defaultSubscriber();
    if (!who.trim()) throw new Problem(400, "--as 不能为空", "usage");
    const query = new URLSearchParams({ as: who });
    for (const key of ["before", "limit"])
      if (str(values, key) !== undefined) query.set(key, str(values, key)!);
    const result = await (
      await client()
    ).get<{ events: InboxEvent[]; next_before: number | null }>(
      `/events?${query}`,
    );
    if (result.next_before !== null)
      recordNext(
        `继续查看：atrium events --as ${who} --before ${result.next_before}`,
      );
    else recordNext(`等新事件：atrium events wait --as ${who}`);
    if (json) printJson(result);
    else if (!result.events.length) console.log(`${who} 没有事件`);
    else console.log(result.events.map(eventLine).join("\n"));
  },
};

const wait: Command = {
  args: "[--as 订阅者] [--timeout 秒] [--settle 秒] [--all]",
  about:
    "缺省只取要处理事件，首条后最多攒批 30 秒；--all 包括过程知会；取走后 15 分钟内不重投",
  options: {
    as: { type: "string" },
    timeout: { type: "string" },
    settle: { type: "string" },
    all: { type: "boolean" },
  },
  positionals: [0, 0],
  async run({ values, json }) {
    const who = str(values, "as") ?? defaultSubscriber();
    if (!who.trim()) throw new Problem(400, "--as 不能为空", "usage");
    const seconds = waitSeconds(str(values, "timeout"));
    const settle = str(values, "settle");
    if (
      settle !== undefined &&
      (!/^(0|[1-9]\d*)$/.test(settle) || Number(settle) > 300)
    )
      throw new Problem(400, "--settle 应为 0～300 的整数秒", "usage");
    const api = await client();
    const query = (timeout: number) =>
      new URLSearchParams({
        as: who,
        timeout: String(timeout),
        ...(settle === undefined ? {} : { settle }),
        ...(values.all === true ? { all: "1" } : {}),
      });
    const result = await longWait<{
      events: InboxEvent[];
      timed_out: boolean;
      restarting?: boolean;
      /** 全局暂停着（server/pause.ts）：事件照常落库，但不投给等待的人。 */
      paused?: string;
    }>(
      seconds,
      (timeout) => api.get(`/events/wait?${query(timeout)}`),
      () => `atrium events wait --as ${who}`,
    );
    const ids = result.events.map((event) => event.id);
    recordNext(
      ids.length
        ? `处理完确认：atrium events ack ${ids.join(" ")}`
        : result.paused
          ? "恢复：atrium resume"
          : `继续等：atrium events wait --as ${who}`,
    );
    if (json) printJson(result);
    else if (result.paused)
      console.log(`${result.paused}：事件照常落库，恢复后再取`);
    else if (!ids.length)
      console.log(
        `${seconds} 秒内 ${who} 没有新事件；atrium events wait --as ${who}`,
      );
    else console.log(result.events.map(eventLine).join("\n"));
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
  events: list,
  "events wait": wait,
  "events ack": ack,
};
