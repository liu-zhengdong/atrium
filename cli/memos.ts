import { readFileSync } from "node:fs";
import { Problem } from "../server/problem.ts";
import { decisionLine, type Decision } from "../server/memos/decisions.ts";
import { recordNext } from "./contract.ts";
import { printJson, when } from "./format.ts";
import type { Command, Values } from "./main.ts";
import { defaultSubscriber } from "./worker-guard.ts";

/**
 * 秘书与 leader 的备忘和决定记录（atrium memo …、atrium decision …）。
 * --as 是记录的主人：secretary 或 aN，缺省秘书（leader 进程里缺省是自己，且只能是自己）。
 * 备忘覆盖写，写当前状态；决定记录追加，写取舍与原因，被推翻的用 supersede 指向新决定。
 */

const str = (values: Values, key: string) => {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
};
const client = async () => (await import("./service.ts")).connect();
const ownerOf = (values: Values) => {
  const who = (str(values, "as") ?? defaultSubscriber()).trim();
  if (!who) throw new Problem(400, "--as 不能为空", "usage");
  return who;
};
const asFlag = (owner: string) =>
  owner === "secretary" ? "" : ` --as ${owner}`;
/** 记录的主人的叫法：秘书，或「a1（名称）」。 */
const whose = (owner: string, name?: string) =>
  owner === "secretary" ? "秘书" : `${owner}${name ? `（${name}）` : ""}`;
/** 接在「已更新」「看」这类字后面：leader 短号前空一格。 */
const afterVerb = (owner: string, name?: string) =>
  owner === "secretary" ? "秘书" : ` ${whose(owner, name)}`;

type Page = {
  decisions: Decision[];
  active: number;
  superseded: number;
  next_before: string | null;
};
type MemoView = Page & {
  owner: string;
  name: string;
  memo: string;
  memo_max: number;
  memo_updated_at: number | null;
};

function memoText(view: MemoView) {
  const size = Array.from(view.memo).length;
  return [
    `${whose(view.owner, view.name)}的备忘（${size}/${view.memo_max} 字${view.memo_updated_at ? ` · ${when(view.memo_updated_at)} 更新` : ""}）：`,
    view.memo || "（空）",
    "",
    `有效的决定（${view.active} 条${view.superseded ? `，另有已推翻 ${view.superseded} 条` : ""}，新的在前）：`,
    ...(view.decisions.length
      ? view.decisions.map((d) => `- ${decisionLine(d)}`)
      : ["（还没有）"]),
  ].join("\n");
}

export const memoCommands: Record<string, Command> = {
  "memo show": {
    args: "[--as secretary|aN]",
    about:
      "看秘书或 leader 的备忘与全部有效的决定（新会话、换人接手先跑这一条）；缺省秘书，leader 进程里缺省自己",
    options: { as: { type: "string" } },
    positionals: [0, 0],
    async run({ values, json }) {
      const owner = ownerOf(values);
      const view = await (
        await client()
      ).get<MemoView>(`/memo?as=${encodeURIComponent(owner)}`);
      if (json) printJson(view);
      else console.log(memoText(view));
      recordNext(
        view.next_before
          ? `往下看：atrium decision ls${asFlag(view.owner)} --before ${view.next_before}`
          : `改备忘：atrium memo edit 文本${asFlag(view.owner)}`,
      );
    },
  },
  "memo edit": {
    args: "[文本] [--file 文件] [--as secretary|aN]",
    about:
      "覆盖写备忘：在等什么、下次先看什么这类当前状态（有长度上限，超了先精简）；取舍与原因记进 decision add",
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
          `已更新${afterVerb(view.owner, view.name)}的备忘（${Array.from(view.memo).length}/${view.memo_max} 字）`,
        );
      recordNext(`看：atrium memo show${asFlag(view.owner)}`);
    },
  },
  "decision add": {
    args: "决定 --why 原因 [--by u1|secretary|aN] [--date 日期] [--issue 号] [--node 节点] [--task tN] [--supersedes dN] [--as secretary|aN]",
    about:
      "追加一条决定记录（谁拍板、决定、原因，可关联 issue、节点、任务）；--by 缺省是记录的主人，补记旧决定用 --date；--supersedes 同时把旧决定标为已推翻",
    options: {
      why: { type: "string" },
      by: { type: "string" },
      date: { type: "string" },
      issue: { type: "string" },
      node: { type: "string" },
      task: { type: "string" },
      supersedes: { type: "string" },
      as: { type: "string" },
    },
    positionals: [1, 1],
    async run({ positionals: [text], values, json }) {
      const owner = ownerOf(values);
      const body: Record<string, string> = { text: text! };
      for (const key of [
        "why",
        "by",
        "date",
        "issue",
        "node",
        "task",
        "supersedes",
      ])
        if (str(values, key) !== undefined) body[key] = str(values, key)!;
      if (body.why === undefined)
        throw new Problem(400, "--why: 原因必填", "usage");
      const decision = await (
        await client()
      ).post<Decision>(`/decisions?as=${encodeURIComponent(owner)}`, body);
      if (json) printJson(decision);
      else
        console.log(
          `已记下 ${decision.ref}（${whose(decision.owner)}的决定记录）\n${decisionLine(decision)}`,
        );
      recordNext(`看全部有效的：atrium decision ls${asFlag(decision.owner)}`);
    },
  },
  "decision ls": {
    args: "[--as secretary|aN] [--all] [--before dN] [--limit 条数]",
    about:
      "列决定记录，日期新的在前；缺省只列有效的，--all 连已推翻的一起列；--before 接着上一页往下",
    options: {
      as: { type: "string" },
      all: { type: "boolean", default: false },
      before: { type: "string" },
      limit: { type: "string" },
    },
    positionals: [0, 0],
    async run({ values, json }) {
      const owner = ownerOf(values);
      const query = new URLSearchParams({ as: owner });
      if (values.all === true) query.set("all", "1");
      for (const key of ["before", "limit"])
        if (str(values, key) !== undefined) query.set(key, str(values, key)!);
      const page = await (
        await client()
      ).get<Page & { owner: string }>(`/decisions?${query}`);
      if (json) printJson(page);
      else
        console.log(
          [
            `${whose(page.owner)}的决定记录：有效 ${page.active} 条，已推翻 ${page.superseded} 条${values.all === true ? "" : "（只列有效的）"}`,
            ...page.decisions.map((d) => `- ${decisionLine(d)}`),
          ].join("\n"),
        );
      recordNext(
        page.next_before
          ? `往下看：atrium decision ls${asFlag(page.owner)}${values.all === true ? " --all" : ""} --before ${page.next_before}`
          : `记一条：atrium decision add 决定 --why 原因${asFlag(page.owner)}`,
      );
    },
  },
  "decision supersede": {
    args: "dN --by dM [--as secretary|aN]",
    about:
      "把旧决定 dN 标为已推翻、指向新决定 dM（两条须在同一份记录里且都还有效）；之后 decision ls 缺省不再列 dN",
    options: { by: { type: "string" }, as: { type: "string" } },
    positionals: [1, 1],
    async run({ positionals: [old], values, json }) {
      const by = str(values, "by");
      if (!by)
        throw new Problem(
          400,
          "--by: 被哪条新决定推翻，如 d5（还没记就先 atrium decision add）",
          "usage",
        );
      const owner = ownerOf(values);
      const result = await (
        await client()
      ).post<{ old: Decision; next: Decision }>(
        `/decisions/${encodeURIComponent(old!)}/supersede?as=${encodeURIComponent(owner)}`,
        { by },
      );
      if (json) printJson(result);
      else
        console.log(
          `已标 ${result.old.ref} 为已推翻，指向 ${result.next.ref}\n- ${decisionLine(result.next)}`,
        );
      recordNext(`看全部有效的：atrium decision ls${asFlag(owner)}`);
    },
  },
};
