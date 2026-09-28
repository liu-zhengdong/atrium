import { readFileSync } from "node:fs";
import { Problem } from "../server/problem.ts";
import { decisionLine, type Decision } from "../server/memos/decisions.ts";
import { recordNext } from "./contract.ts";
import { printJson, when } from "./format.ts";
import type { Command, Values } from "./main.ts";
import { str, strs } from "./args.ts";
import { defaultSubscriber } from "./worker-guard.ts";

/**
 * 备忘和决定记录（atrium memo …、atrium decision …）。
 * 备忘：每位一份（--as secretary、u1 或 aN，缺省秘书；leader 进程里缺省是自己），覆盖写，写当前状态。
 * 决定记录：只记用户拍板的事与原因，给人回看；要守的规矩写成要点（org point-add），处理过程写任务备注。
 */

const client = async () => (await import("./service.ts")).connect();
const ownerOf = (values: Values) => {
  const who = (str(values, "as") ?? defaultSubscriber()).trim();
  if (!who) throw new Problem(400, "--as 不能为空", "usage");
  return who;
};
const asFlag = (owner: string) =>
  owner === "secretary" ? "" : ` --as ${owner}`;
/** 备忘主人的叫法：秘书、用户，或「a1（名称）」。 */
const whose = (owner: string, name?: string) =>
  owner === "secretary"
    ? "秘书"
    : owner === "u1"
      ? "用户"
      : `${owner}${name ? `（${name}）` : ""}`;

type Page = {
  decisions: Decision[];
  active: number;
  superseded: number;
  next_before: string | null;
};
type MemoView = {
  owner: string;
  name: string;
  memo: string;
  memo_max: number;
  memo_updated_at: number | null;
};

export const memoCommands: Record<string, Command> = {
  "memo show": {
    args: "[--as secretary|u1|aN]",
    about:
      "看备忘（新会话、换人接手先跑这一条）：在等什么、下次先看什么；缺省秘书，leader 进程里缺省自己",
    options: { as: { type: "string" } },
    positionals: [0, 0],
    async run({ values, json }) {
      const owner = ownerOf(values);
      const view = await (
        await client()
      ).get<MemoView>(`/memo?as=${encodeURIComponent(owner)}`);
      if (json) printJson(view);
      else
        console.log(
          [
            `${whose(view.owner, view.name)}的备忘（${Array.from(view.memo).length}/${view.memo_max} 字${view.memo_updated_at ? ` · ${when(view.memo_updated_at)} 更新` : ""}）：`,
            view.memo || "（空）",
          ].join("\n"),
        );
      recordNext(`改备忘：atrium memo edit 文本${asFlag(view.owner)}`);
    },
  },
  "memo edit": {
    args: "[文本] [--file 文件] [--as secretary|aN]",
    about:
      "覆盖写备忘：在等什么、下次先看什么这类当前状态（有长度上限，超了先精简）",
    options: { as: { type: "string" }, file: { type: "string" } },
    positionals: [0, 1],
    async run({ positionals: [text], values, json }) {
      const file = str(values, "file");
      if ((text === undefined) === (file === undefined))
        throw new Problem(
          400,
          "备忘正文给一种：直接写文本，或 --file 文件",
          "usage",
        );
      let memo = text;
      if (file !== undefined) {
        try {
          memo = readFileSync(file, "utf8");
        } catch {
          throw new Problem(400, `--file: 读不到 ${file}`, "usage");
        }
      }
      const owner = ownerOf(values);
      const view = await (
        await client()
      ).put<MemoView>(`/memo?as=${encodeURIComponent(owner)}`, { memo });
      if (json) printJson(view);
      else
        console.log(
          `已更新${whose(view.owner, view.name)}的备忘（${Array.from(view.memo).length}/${view.memo_max} 字）`,
        );
      recordNext(`看：atrium memo show${asFlag(view.owner)}`);
    },
  },
  "decision add": {
    args: "决定 --why 原因 [--date 日期] [--issue 号] [--node 节点]… [--task tN] [--supersedes dN]",
    about:
      "记一条用户拍板的决定与原因（给人回看，不附进提示词）；可关联 issue、一个或多个节点、任务；补记旧决定用 --date；--supersedes 同时把旧决定标为已推翻。要大家守的规矩写成要点：atrium org point-add",
    options: {
      why: { type: "string" },
      date: { type: "string" },
      issue: { type: "string" },
      node: { type: "string", multiple: true },
      task: { type: "string" },
      supersedes: { type: "string" },
    },
    positionals: [1, 1],
    async run({ positionals: [text], values, json }) {
      const body: Record<string, unknown> = { text: text! };
      for (const key of ["why", "date", "issue", "task", "supersedes"])
        if (str(values, key) !== undefined) body[key] = str(values, key)!;
      if (strs(values, "node").length) body.node = strs(values, "node");
      if (body.why === undefined)
        throw new Problem(400, "--why: 原因必填", "usage");
      const decision = await (
        await client()
      ).post<Decision>("/decisions", body);
      if (json) printJson(decision);
      else console.log(`已记下 ${decision.ref}\n${decisionLine(decision)}`);
      recordNext(
        decision.nodes.length
          ? `看这一块的：atrium decision ls --node ${decision.nodes[0]!.ref}`
          : "看全部：atrium decision ls",
      );
    },
  },
  "decision ls": {
    args: "[关键词…] [--node 节点] [--all] [--before dN] [--limit 条数]",
    about:
      "列用户拍板的决定，日期新的在前；给关键词只列决定与原因里全部命中的；--node 只列挂在该节点及其上级的；缺省只列没被推翻的，--all 连已推翻的；--before 接着上一页往下",
    options: {
      node: { type: "string" },
      all: { type: "boolean", default: false },
      before: { type: "string" },
      limit: { type: "string" },
    },
    positionals: [0, 5],
    async run({ positionals, values, json }) {
      const query = new URLSearchParams();
      if (values.all === true) query.set("all", "1");
      for (const key of ["before", "limit", "node"])
        if (str(values, key) !== undefined) query.set(key, str(values, key)!);
      if (positionals.length) query.set("q", positionals.join(" "));
      const page = await (await client()).get<Page>(`/decisions?${query}`);
      if (json) printJson(page);
      else
        console.log(
          [
            `决定记录：有效 ${page.active} 条，已推翻 ${page.superseded} 条${values.all === true ? "" : "（只列有效的）"}`,
            ...page.decisions.map((d) => `- ${decisionLine(d)}`),
          ].join("\n"),
        );
      const again = [
        ...positionals,
        ...(str(values, "node") ? [`--node ${str(values, "node")}`] : []),
        ...(values.all === true ? ["--all"] : []),
      ].join(" ");
      recordNext(
        page.next_before
          ? `往下看：atrium decision ls${again ? ` ${again}` : ""} --before ${page.next_before}`
          : "记一条：atrium decision add 决定 --why 原因",
      );
    },
  },
};
