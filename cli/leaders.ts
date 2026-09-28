import { readFileSync } from "node:fs";
import { Problem } from "../server/problem.ts";
import type { LeaderView, LeaderWake } from "../server/leaders/model.ts";
import { ESCALATE_KINDS } from "../server/leaders/wake.ts";
import { recordNext } from "./contract.ts";
import { printJson, when } from "./format.ts";
import type { Command } from "./main.ts";
import { str } from "./args.ts";

/**
 * leader 层（atrium leader …）：aN 是固定身份，按事唤醒、无常驻会话。
 * 登记与改名、换执行者只有用户能做；leader 进程里只能改自己的备忘、替自己上交（服务端判定）。
 */

const client = async () => (await import("./service.ts")).connect();
const enc = encodeURIComponent;

const STATUS: Record<LeaderWake["status"], string> = {
  running: "处理中",
  done: "处理完",
  failed: "失败",
  handed_off: "已转交",
};

/** 最近一次唤醒的一句话（org tree、top 共用）。 */
export function wakeText(wake: LeaderWake | null | undefined): string {
  if (!wake) return "还没唤醒过";
  const what = wake.summary ? `：${wake.summary}` : "";
  return wake.status === "running"
    ? `${when(wake.at)}起处理中${what}`
    : `${when(wake.at)}唤醒 · ${STATUS[wake.status]}${what}${wake.note ? `（${wake.note}）` : ""}`;
}

function detail(view: LeaderView): string {
  return [
    `${view.ref} ${view.name} · 执行者 ${view.worker}`,
    `负责：${view.nodes.map((n) => `${n.ref} ${n.name}（${n.path}）`).join("、") || "（还没指派节点：atrium org edit 节点 --leader " + view.ref + "）"}`,
    `最近唤醒：${wakeText(view.wake)}${view.wake ? ` · 共 ${view.wake.count} 次` : ""}`,
    `备忘（${Array.from(view.memo).length}/${view.memo_max} 字）：${view.memo ? `\n${view.memo}` : "（空）"}`,
  ].join("\n");
}

const self = () =>
  process.env.ATRIUM_LEADER_TOKEN?.trim() && process.env.ATRIUM_LEADER?.trim()
    ? process.env.ATRIUM_LEADER.trim()
    : undefined;

export const leaderCommands: Record<string, Command> = {
  "leader ls": {
    args: "[aN]",
    about:
      "列出 leader：负责的节点、执行者组合、最近一次唤醒在处理什么；节点上引用了但没登记的单列；给 aN 看这一位的详情与备忘",
    positionals: [0, 1],
    async run({ positionals: [who], json }) {
      if (who !== undefined) {
        const view = await (
          await client()
        ).get<LeaderView>(`/leaders/${enc(who)}`);
        if (json) printJson(view);
        else console.log(detail(view));
        recordNext(`看它的事件：atrium events --as ${view.ref}`);
        return;
      }
      const result = await (
        await client()
      ).get<{
        leaders: LeaderView[];
        unregistered: { ref: string; nodes: LeaderView["nodes"] }[];
      }>("/leaders");
      if (json) printJson(result);
      else
        console.log(
          [
            ...result.leaders.map(
              (l) =>
                `${l.ref} ${l.name} · ${l.worker} · 负责 ${l.nodes.map((n) => `${n.ref} ${n.name}`).join("、") || "（无）"} · ${wakeText(l.wake)}`,
            ),
            ...result.unregistered.map(
              (u) =>
                `${u.ref}（未登记）· 负责 ${u.nodes.map((n) => `${n.ref} ${n.name}`).join("、")} · 事件不会投给它，登记：atrium leader add 名称 --worker claude+opus --id ${u.ref}`,
            ),
          ].join("\n") || "还没有 leader",
        );
      recordNext(
        result.leaders.length
          ? `看一位：atrium leader ls ${result.leaders[0]!.ref}`
          : "登记：atrium leader add 名称 --worker claude+opus",
      );
    },
  },
  "leader add": {
    args: "名称 --worker 工具+模型[:强度] [--memo 文本] [--id aN]",
    about:
      "登记 leader（固定身份，按事唤醒时用 --worker 的执行者组合起一次性进程）；--id 认领节点上已引用但没登记的 aN；再用 org edit 节点 --leader aN 指派",
    options: {
      worker: { type: "string" },
      memo: { type: "string" },
      id: { type: "string" },
    },
    positionals: [1, 1],
    async run({ positionals: [name], values, json }) {
      if (!str(values, "worker"))
        throw new Problem(
          400,
          "--worker 必填：leader 被唤醒时用哪个执行者组合，如 claude+opus:high",
          "usage",
        );
      const view = await (
        await client()
      ).post<LeaderView>("/leaders", {
        name,
        worker: str(values, "worker"),
        ...(str(values, "memo") === undefined
          ? {}
          : { memo: str(values, "memo") }),
        ...(str(values, "id") === undefined ? {} : { id: str(values, "id") }),
      });
      if (json) printJson(view);
      else
        console.log(`已登记 ${view.ref} ${view.name} · 执行者 ${view.worker}`);
      recordNext(`指派节点：atrium org edit 节点 --leader ${view.ref}`);
    },
  },
  "leader edit": {
    args: "aN [--name 名称] [--worker 工具+模型[:强度]] [--memo 文本|--memo-file 文件]",
    about:
      "改 leader 的名称、执行者组合或备忘（覆盖写，有长度上限，超了先精简）；leader 自己只能改自己的备忘",
    options: {
      name: { type: "string" },
      worker: { type: "string" },
      memo: { type: "string" },
      "memo-file": { type: "string" },
    },
    positionals: [1, 1],
    async run({ positionals: [who], values, json }) {
      if (str(values, "memo") !== undefined && str(values, "memo-file"))
        throw new Problem(400, "--memo 与 --memo-file 只能给一个", "usage");
      let memo = str(values, "memo");
      const file = str(values, "memo-file");
      if (file !== undefined) {
        try {
          memo = readFileSync(file, "utf8");
        } catch {
          throw new Problem(400, `--memo-file: 读不到 ${file}`, "usage");
        }
      }
      const body = {
        ...(str(values, "name") === undefined
          ? {}
          : { name: str(values, "name") }),
        ...(str(values, "worker") === undefined
          ? {}
          : { worker: str(values, "worker") }),
        ...(memo === undefined ? {} : { memo }),
      };
      if (!Object.keys(body).length)
        throw new Problem(
          400,
          "至少改一项：--name、--worker、--memo 或 --memo-file",
          "usage",
        );
      const view = await (
        await client()
      ).patch<LeaderView>(`/leaders/${enc(who!)}`, body);
      if (json) printJson(view);
      else console.log(`已更新 ${view.ref}\n${detail(view)}`);
      recordNext(`看：atrium leader ls ${view.ref}`);
    },
  },
  "leader escalate": {
    args: "说明 --kind shipped|cross|beyond|stuck [--task tN] [--event 编号] [--as aN]",
    about: `leader 上交给上一层（秘书或上层 leader），生成一条「要处理」事件；只有四类：${Object.entries(
      ESCALATE_KINDS,
    )
      .map(([k, v]) => `${k} ${v}`)
      .join(
        "、",
      )}；shipped 要带 --task。转交下层 leader 的上交时用 --event 给那条事件的编号、说明写你的意见（同任务同类型的会自动认作转交），上面只收一条。leader 进程里缺省以自己的身份上交`,
    options: {
      kind: { type: "string" },
      task: { type: "string" },
      event: { type: "string" },
      as: { type: "string" },
    },
    positionals: [1, 1],
    async run({ positionals: [note], values, json }) {
      const who = str(values, "as") ?? self();
      if (!who)
        throw new Problem(
          400,
          "--as: 以哪位 leader 的名义上交，如 a1（leader 进程里缺省是自己）",
          "usage",
        );
      const kind = str(values, "kind");
      if (!kind)
        throw new Problem(
          400,
          `--kind 必填：${Object.keys(ESCALATE_KINDS).join("、")}`,
          "usage",
        );
      const result = await (
        await client()
      ).post<{
        event: number;
        to: string;
        why: string;
        kind_label: string;
        task: string | null;
        forwarded: number | null;
      }>(`/leaders/${enc(who)}/escalate`, {
        kind,
        note,
        ...(str(values, "task") === undefined
          ? {}
          : { task: str(values, "task") }),
        ...(str(values, "event") === undefined
          ? {}
          : { event: str(values, "event") }),
      });
      if (json) printJson(result);
      else
        console.log(
          `${result.forwarded === null ? "已上交" : `已转交 #${result.forwarded} `}「${result.kind_label}」给 ${result.to === "secretary" ? "秘书" : result.to}（事件 #${result.event}${result.task ? ` · ${result.task}` : ""}）\n${result.why}`,
        );
      recordNext(`处理完这批事件后确认：atrium events ack 编号`);
    },
  },
};
