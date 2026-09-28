import { readFileSync } from "node:fs";
import { Problem } from "../server/problem.ts";
import { decisionLine, type Decision } from "../server/memos/decisions.ts";
import { omittedLine } from "../server/memos/digest.ts";
import { recordNext } from "./contract.ts";
import { printJson, when } from "./format.ts";
import type { Command, Values } from "./main.ts";
import { defaultSubscriber } from "./worker-guard.ts";

/**
 * 备忘和决定记录（atrium memo …、atrium decision …）。
 * --as 是记录的主人：secretary、u1（用户自己那份）或 aN，缺省秘书（leader 进程里缺省是自己，且只能是自己）。
 * 备忘覆盖写，写当前状态；决定记录追加，写取舍与原因，--by u1 的记进用户那份。
 * memo show 只给摘要（原则 + 最近的，有字数上限），全部用 decision ls --node / decision search 查（t211）。
 */

const str = (values: Values, key: string) => {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
};
const strs = (values: Values, key: string) => {
  const value = values[key];
  if (Array.isArray(value))
    return value.filter((item): item is string => typeof item === "string");
  return typeof value === "string" ? [value] : [];
};
const client = async () => (await import("./service.ts")).connect();
const ownerOf = (values: Values) => {
  const who = (str(values, "as") ?? defaultSubscriber()).trim();
  if (!who) throw new Problem(400, "--as 不能为空", "usage");
  return who;
};
const asFlag = (owner: string) =>
  owner === "secretary" ? "" : ` --as ${owner}`;
/** 记录的主人的叫法：秘书、用户，或「a1（名称）」。 */
const whose = (owner: string, name?: string) =>
  owner === "secretary"
    ? "秘书"
    : owner === "u1"
      ? "用户"
      : `${owner}${name ? `（${name}）` : ""}`;
/** 接在「已更新」「看」这类字后面：leader 短号前空一格。 */
const afterVerb = (owner: string, name?: string) =>
  owner === "secretary" || owner === "u1"
    ? whose(owner)
    : ` ${whose(owner, name)}`;
const lines = (list: readonly Decision[]) =>
  list.map((d) => `- ${decisionLine(d)}`);

type Page = {
  decisions: Decision[];
  active: number;
  superseded: number;
  settled: number;
  next_before: string | null;
};
type MemoView = {
  owner: string;
  name: string;
  memo: string;
  memo_max: number;
  memo_updated_at: number | null;
  /** 多个分身同时在跑时各自写的分段（t275）。 */
  memo_parts?: { part: string; body: string; updated_at: number }[];
  /** leader 分身这次写进了哪一段；合并或写主备忘时没有。 */
  written_to?: string;
  decisions: Decision[];
  principles: number;
  total: number;
  omitted: number;
};

function memoText(view: MemoView) {
  const size = Array.from(view.memo).length;
  const recent = view.decisions.length - view.principles;
  const scope =
    view.owner === "secretary"
      ? "秘书与用户的"
      : view.owner === "u1"
        ? "用户的"
        : "自己的、挂在负责部分及上级的";
  return [
    ...(view.owner === "u1"
      ? []
      : [
          `${whose(view.owner, view.name)}的备忘（${size}/${view.memo_max} 字${view.memo_updated_at ? ` · ${when(view.memo_updated_at)} 更新` : ""}）：`,
          view.memo || "（空）",
          ...(view.memo_parts?.length
            ? [
                "各分身写的分段（还没合并；只剩一个分身时它写备忘即合并）：",
                ...view.memo_parts.map(
                  (p) => `【${p.part}】${when(p.updated_at)}：${p.body}`,
                ),
              ]
            : []),
          "",
        ]),
    `决定摘要（${scope}，有效 ${view.total} 条；原则 ${view.principles} 条 + 最近 ${recent} 条）：`,
    ...(view.decisions.length ? lines(view.decisions) : ["（还没有）"]),
    ...[omittedLine(view.omitted)].filter((l): l is string => l !== null),
  ].join("\n");
}

function pageText(title: string, page: Page, all: boolean) {
  return [
    `${title}：有效 ${page.active} 条，已推翻 ${page.superseded} 条，已沉淀 ${page.settled} 条${all ? "" : "（只列有效的）"}`,
    ...lines(page.decisions),
  ].join("\n");
}

const pageQuery = (values: Values) => {
  const query = new URLSearchParams();
  if (values.all === true) query.set("all", "1");
  for (const key of ["before", "limit", "node"])
    if (str(values, key) !== undefined) query.set(key, str(values, key)!);
  return query;
};

export const memoCommands: Record<string, Command> = {
  "memo show": {
    args: "[--as secretary|u1|aN]",
    about:
      "看备忘与决定摘要（新会话、换人接手先跑这一条）：标了原则的全列，再加最近 15 条，超过字数上限的只给一行「另有 N 条」；秘书的含用户的决定，leader 的只取自己部分及上级的；缺省秘书，leader 进程里缺省自己",
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
        view.omitted
          ? "查：atrium decision ls --node 节点 或 atrium decision search 关键词"
          : `改备忘：atrium memo edit 文本${asFlag(view.owner)}`,
      );
    },
  },
  "memo edit": {
    args: "[文本] [--file 文件] [--as secretary|aN]",
    about:
      "覆盖写备忘：在等什么、下次先看什么这类当前状态（有长度上限，超了先精简）；取舍与原因记进 decision add。leader 有几个分身同时在跑时只写自己认领那件事的分段，不覆盖别的分身；只剩一个分身时它写的就是合并后的全文",
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
          view.written_to
            ? `别的分身还在跑，已写进${afterVerb(view.owner, view.name)}备忘的「${view.written_to}」分段（只剩一个分身时合并）`
            : `已更新${afterVerb(view.owner, view.name)}的备忘（${Array.from(view.memo).length}/${view.memo_max} 字）`,
        );
      recordNext(`看：atrium memo show${asFlag(view.owner)}`);
    },
  },
  "decision add": {
    args: "决定 --why 原因 [--by u1|secretary|aN] [--date 日期] [--issue 号] [--node 节点]… [--task tN] [--supersedes dN] [--principle] [--as secretary|aN]",
    about:
      "追加一条决定记录（谁拍板、决定、原因，可关联 issue、一个或多个节点、任务）；--by 缺省是记录的主人，--by u1 的记进用户那份；补记旧决定用 --date；--supersedes 同时把旧决定标为已推翻；--principle 标为原则（摘要里总列出）",
    options: {
      why: { type: "string" },
      by: { type: "string" },
      date: { type: "string" },
      issue: { type: "string" },
      node: { type: "string", multiple: true },
      task: { type: "string" },
      supersedes: { type: "string" },
      principle: { type: "boolean", default: false },
      as: { type: "string" },
    },
    positionals: [1, 1],
    async run({ positionals: [text], values, json }) {
      const owner = ownerOf(values);
      const body: Record<string, unknown> = { text: text! };
      for (const key of ["why", "by", "date", "issue", "task", "supersedes"])
        if (str(values, key) !== undefined) body[key] = str(values, key)!;
      if (strs(values, "node").length) body.node = strs(values, "node");
      if (values.principle === true) body.principle = true;
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
      recordNext(
        decision.nodes.length
          ? `看这一块的：atrium decision ls --node ${decision.nodes[0]!.ref}`
          : `挂到部分上：atrium decision tag ${decision.ref} --node 节点`,
      );
    },
  },
  "decision ls": {
    args: "[--as secretary|u1|aN] [--node 节点] [--all] [--before dN] [--limit 条数]",
    about:
      "列决定记录，日期新的在前；缺省列 --as 那一份，--node 列挂在该节点及其上级的（谁记的都算）；缺省只列有效的，--all 连已推翻、已沉淀的一起列；--before 接着上一页往下",
    options: {
      as: { type: "string" },
      node: { type: "string" },
      all: { type: "boolean", default: false },
      before: { type: "string" },
      limit: { type: "string" },
    },
    positionals: [0, 0],
    async run({ values, json }) {
      const query = pageQuery(values);
      if (!query.has("node")) query.set("as", ownerOf(values));
      const page = await (
        await client()
      ).get<Page & { owner?: string; node?: string }>(`/decisions?${query}`);
      const where = page.node
        ? ` --node ${page.node}`
        : asFlag(page.owner ?? "secretary");
      if (json) printJson(page);
      else
        console.log(
          pageText(
            page.node
              ? `挂在 ${page.node} 及其上级的决定`
              : `${whose(page.owner ?? "secretary")}的决定记录`,
            page,
            values.all === true,
          ),
        );
      recordNext(
        page.next_before
          ? `往下看：atrium decision ls${where}${values.all === true ? " --all" : ""} --before ${page.next_before}`
          : `记一条：atrium decision add 决定 --why 原因${page.node ? ` --node ${page.node}` : asFlag(page.owner ?? "secretary")}`,
      );
    },
  },
  "decision search": {
    args: "关键词 [--node 节点] [--as secretary|u1|aN] [--all] [--before dN] [--limit 条数]",
    about:
      "按关键词查决定（决定与原因里都算，空格隔开的几个词须全部命中）；缺省查所有人的有效决定，--node 只查挂在该节点及其上级的，--as 只查那一份，--all 连已推翻、已沉淀的",
    options: {
      node: { type: "string" },
      as: { type: "string" },
      all: { type: "boolean", default: false },
      before: { type: "string" },
      limit: { type: "string" },
    },
    positionals: [1, 1],
    async run({ positionals: [text], values, json }) {
      const query = pageQuery(values);
      query.set("q", text!);
      if (str(values, "as") !== undefined)
        query.set("owner", str(values, "as")!);
      const page = await (
        await client()
      ).get<Page & { query: string }>(`/decisions/search?${query}`);
      if (json) printJson(page);
      else
        console.log(
          page.decisions.length
            ? pageText(`含「${page.query}」的决定`, page, values.all === true)
            : `没有含「${page.query}」的${values.all === true ? "" : "有效"}决定`,
        );
      recordNext(
        page.next_before
          ? `往下看：atrium decision search ${JSON.stringify(text)}${values.all === true ? " --all" : ""} --before ${page.next_before}`
          : values.all === true
            ? "看摘要：atrium memo show"
            : `连已推翻、已沉淀的一起查：atrium decision search ${JSON.stringify(text)} --all`,
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
  "decision unsupersede": {
    args: "dN --why 原因 [--as secretary|u1|aN]",
    about:
      "推翻标错了时撤销：dN 恢复为有效，记一笔谁撤销的、为什么、原先被哪条推翻",
    options: { why: { type: "string" }, as: { type: "string" } },
    positionals: [1, 1],
    async run({ positionals: [id], values, json }) {
      const why = str(values, "why");
      if (!why) throw new Problem(400, "--why: 为什么撤销，原因必填", "usage");
      const owner = ownerOf(values);
      const decision = await (
        await client()
      ).post<Decision>(
        `/decisions/${encodeURIComponent(id!)}/unsupersede?as=${encodeURIComponent(owner)}`,
        { why },
      );
      if (json) printJson(decision);
      else
        console.log(
          `已撤销 ${decision.ref} 的推翻（原先被 ${decision.restored?.from ?? "?"} 推翻），恢复为有效\n- ${decisionLine(decision)}`,
        );
      recordNext(`看：atrium decision ls${asFlag(decision.owner)}`);
    },
  },
  "decision tag": {
    args: "dN --node 节点… [--as secretary|aN]",
    about:
      "给已有决定补挂节点（--node 可给多次，已挂的不重复）；挂上后 decision ls --node 与该部分 leader 的摘要里都能看到",
    options: {
      node: { type: "string", multiple: true },
      as: { type: "string" },
    },
    positionals: [1, 1],
    async run({ positionals: [id], values, json }) {
      const nodes = strs(values, "node");
      if (!nodes.length)
        throw new Problem(400, "--node: 挂到哪个节点，如 o3", "usage");
      const owner = ownerOf(values);
      const decision = await (
        await client()
      ).post<Decision>(
        `/decisions/${encodeURIComponent(id!)}/tag?as=${encodeURIComponent(owner)}`,
        { node: nodes },
      );
      if (json) printJson(decision);
      else
        console.log(
          `已给 ${decision.ref} 挂上 ${decision.nodes.map((n) => `${n.ref}${n.name ? `（${n.name}）` : ""}`).join("、")}\n- ${decisionLine(decision)}`,
        );
      recordNext(`看这一块的：atrium decision ls --node ${nodes[0]}`);
    },
  },
  "decision mark": {
    args: "dN --principle|--normal [--as secretary|aN]",
    about: "标为原则（--principle，摘要里总列出）或改回普通决定（--normal）",
    options: {
      principle: { type: "boolean", default: false },
      normal: { type: "boolean", default: false },
      as: { type: "string" },
    },
    positionals: [1, 1],
    async run({ positionals: [id], values, json }) {
      if ((values.principle === true) === (values.normal === true))
        throw new Problem(
          400,
          "--principle: 标原则给 --principle，改回普通给 --normal（二选一）",
          "usage",
        );
      const owner = ownerOf(values);
      const decision = await (
        await client()
      ).post<Decision>(
        `/decisions/${encodeURIComponent(id!)}/mark?as=${encodeURIComponent(owner)}`,
        { principle: values.principle === true },
      );
      if (json) printJson(decision);
      else
        console.log(
          `${decision.ref} 已${decision.principle ? "标为原则" : "改回普通决定"}\n- ${decisionLine(decision)}`,
        );
      recordNext(`看摘要：atrium memo show${asFlag(owner)}`);
    },
  },
  "decision settle": {
    args: "dN (--point kN | --new-point 节点 要点) [--why 为什么] [--by 谁定的] [--as secretary|aN]",
    about:
      "已成规矩的决定沉淀成要点：--point 指向已有的要点，或 --new-point 在节点上新建一条（为什么缺省用决定的原因，谁定的缺省拍板人与日期）；决定标「已沉淀到 kN」、缺省列表与摘要不再显示，要点记来源 dN",
    options: {
      point: { type: "string" },
      "new-point": { type: "string" },
      why: { type: "string" },
      by: { type: "string" },
      as: { type: "string" },
    },
    positionals: [1, 2],
    async run({ positionals: [id, text], values, json }) {
      const point = str(values, "point");
      const node = str(values, "new-point");
      if ((point === undefined) === (node === undefined))
        throw new Problem(
          400,
          "沉淀到哪：已有的要点给 --point kN，新建给 --new-point 节点 要点",
          "usage",
        );
      if (node !== undefined && text === undefined)
        throw new Problem(
          400,
          "要点: --new-point 节点 后面接要点文字",
          "usage",
        );
      if (point !== undefined && text !== undefined)
        throw new Problem(400, `${text}: 多余的参数`, "usage");
      const body: Record<string, unknown> =
        point !== undefined ? { point } : { new_point: { node, text } };
      for (const key of ["why", "by"])
        if (str(values, key) !== undefined) body[key] = str(values, key)!;
      const owner = ownerOf(values);
      const result = await (
        await client()
      ).post<{ decision: Decision; point: string }>(
        `/decisions/${encodeURIComponent(id!)}/settle?as=${encodeURIComponent(owner)}`,
        body,
      );
      if (json) printJson(result);
      else
        console.log(
          `已把 ${result.decision.ref} 沉淀到要点 ${result.point}\n- ${decisionLine(result.decision)}`,
        );
      recordNext(`看要点：atrium org show ${node ?? "节点"}`);
    },
  },
};
