import { readFileSync } from "node:fs";
import { Problem } from "../server/problem.ts";
import type {
  Choice,
  Decided,
  DeciderSetting,
} from "../server/choices/store.ts";
import { commentLine } from "../server/choices/model.ts";
import { recordNext } from "./contract.ts";
import { oneLine, printJson, when } from "./format.ts";
import type { Command, Values } from "./main.ts";

/**
 * 选项单（atrium choice …）：产品部提 3–5 个选项，用户拍板做哪些。
 * 选中的在该节点下建任务交 leader 拆解，没选的连同说明记成决定记录，下一轮产品部读得到。
 */

const str = (values: Values, key: string) => {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
};
const client = async () => (await import("./service.ts")).connect();
const enc = encodeURIComponent;

type Page = { choices: Choice[]; open: number; next_before: string | null };

const who = (by: string) => (by === "secretary" ? "秘书" : by);

function optionText(choice: Choice, o: Choice["options"][number]) {
  const star = choice.recommend.includes(o.seq) ? "（推荐）" : "";
  const fate =
    o.picked === true
      ? ` → 已选，建了 ${o.task}`
      : o.picked === false
        ? ` → 没选，记为 ${o.decision}`
        : "";
  return [
    `${o.seq}. ${o.title}${star}${fate}`,
    `   能多做到：${o.gain}`,
    `   为什么现在：${o.why_now}`,
    `   代价：${o.cost}`,
    `   不做会怎样：${o.skip}`,
    ...(o.basis.length ? [`   依据：${o.basis.join("；")}`] : []),
  ].join("\n");
}

const deciderName = (by: string | null) =>
  by === "u1" || by === null ? "用户" : by;

export function choiceText(choice: Choice): string {
  const decided = choice.decided_at
    ? `；${deciderName(choice.decided_by)}拍板于 ${when(choice.decided_at)}`
    : "";
  return [
    `${choice.ref} ${choice.title} · ${choice.status_text} · ${choice.node_alias || choice.node_name}（${choice.node}）`,
    `${who(choice.created_by)}提于 ${when(choice.created_at)}${choice.task ? `，出自 ${choice.task}` : ""}${decided}`,
    ...(choice.status === "open"
      ? [`拍板人：${choice.decider}（${choice.decider_why}）`]
      : []),
    ...(choice.note
      ? [`${deciderName(choice.decided_by)}说明：${choice.note}`]
      : []),
    "",
    ...choice.options.map((o) => optionText(choice, o)),
    "",
    `推荐：选项 ${choice.recommend.join("、")}——${choice.why}`,
    ...(choice.small ? [choice.small.text] : []),
    ...(choice.comments.length
      ? ["", "意见：", ...choice.comments.map((c) => `- ${commentLine(c)}`)]
      : []),
  ].join("\n");
}

const line = (c: Choice) =>
  `${c.ref} ${oneLine(c.title, 40)} · ${c.status_text} · ${c.node_alias || c.node_name}（${c.node}）· ${c.options.length} 个选项${
    c.status === "picked"
      ? `，选了 ${c.options
          .filter((o) => o.picked)
          .map((o) => o.seq)
          .join("、")}`
      : ""
  }`;

const settingText = (s: DeciderSetting) =>
  `${s.node_name}（${s.node}）的选项单由 ${s.decider === "u1" ? "用户（u1）" : s.decider} 拍板：${s.why}${s.setting === null ? "；本节点没单独设" : ""}`;

function readChoiceFile(file: string): unknown {
  if (file === "-" && process.stdin.isTTY)
    throw new Problem(
      400,
      "--file - 从标准输入读选项单，需要用管道或重定向传入，如 atrium choice add o2 --file - < 选项单.json",
      "usage",
    );
  let raw: string;
  try {
    raw = readFileSync(file === "-" ? 0 : file, "utf8");
  } catch {
    throw new Problem(
      400,
      `--file: 读不到 ${file === "-" ? "标准输入" : file}`,
      "usage",
    );
  }
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    throw new Problem(
      400,
      '--file: 不是合法的 JSON；格式见 atrium choice add --help（{"title","options":[…],"recommend":[1],"why"}）',
      "usage",
    );
  }
}

export const choiceCommands: Record<string, Command> = {
  "choice ls": {
    args: "[--node 节点] [--open] [--before cN] [--limit 份数]",
    about:
      "列选项单，等拍板的在前、新的在前；--node 只看这一块及下层（产品部），--open 只看等拍板的",
    options: {
      node: { type: "string" },
      open: { type: "boolean", default: false },
      before: { type: "string" },
      limit: { type: "string" },
    },
    positionals: [0, 0],
    async run({ values, json }) {
      const query = new URLSearchParams();
      if (str(values, "node")) query.set("node", str(values, "node")!);
      if (values.open === true) query.set("open", "1");
      for (const key of ["before", "limit"])
        if (str(values, key) !== undefined) query.set(key, str(values, key)!);
      const page = await (
        await client()
      ).get<Page>(`/choices${query.size ? `?${query}` : ""}`);
      if (json) printJson(page);
      else
        console.log(
          page.choices.length
            ? [
                `等你拍板 ${page.open} 份`,
                ...page.choices.map((c) => `- ${line(c)}`),
              ].join("\n")
            : values.open === true
              ? "没有等你拍板的选项单"
              : "还没有选项单",
        );
      const first = page.choices.find((c) => c.status === "open");
      recordNext(
        page.next_before
          ? `往下看：atrium choice ls${values.open === true ? " --open" : ""}${str(values, "node") ? ` --node ${str(values, "node")}` : ""} --before ${page.next_before}`
          : first
            ? `看全文再拍板：atrium choice show ${first.ref}`
            : "看全景：atrium map",
      );
    },
  },
  "choice show": {
    args: "cN",
    about:
      "看一份选项单全文：每个选项能多做到什么、为什么现在、代价、不做会怎样、依据，产品部的推荐与理由，拍过板的写明建了哪些任务、记了哪些决定",
    positionals: [1, 1],
    async run({ positionals: [ref], json }) {
      const choice = await (
        await client()
      ).get<Choice>(`/choices/${enc(ref!)}`);
      if (json) printJson(choice);
      else console.log(choiceText(choice));
      recordNext(
        choice.status !== "open"
          ? `看节点：atrium map ${choice.node}`
          : process.env.ATRIUM_LEADER_TOKEN && choice.decider === "u1"
            ? `写意见：atrium choice comment ${choice.ref} 意见 --prefer ${choice.recommend.join(",")} --basis 依据`
            : `拍板：atrium choice pick ${choice.ref} ${choice.recommend.join(" ")} --note 说明（这轮都不要：atrium choice pass ${choice.ref} --note 原因）`,
      );
    },
  },
  "choice pick": {
    args: "cN 选项号… [--note 说明]",
    about:
      "拍板要做哪几个：选中的在该节点下各建一个任务（带选项全文作详述，交该节点 leader 拆解），没选的连同说明记成该节点的决定记录（这轮不做 X：原因）；拍板人缺省是用户，atrium product set 下放后该节点的 leader 也能拍",
    options: { note: { type: "string" } },
    positionals: [2, 6],
    async run({ positionals: [ref, ...picks], values, json }) {
      const result = await (
        await client()
      ).post<Decided>(`/choices/${enc(ref!)}/pick`, {
        picks,
        ...(str(values, "note") !== undefined
          ? { note: str(values, "note") }
          : {}),
      });
      if (json) printJson(result);
      else
        console.log(
          [
            `${result.choice.ref} 已拍板`,
            ...result.tasks.map(
              (t) => `- 选项 ${t.option}「${t.title}」→ 建了 ${t.ref}`,
            ),
            ...result.decisions.map(
              (d) =>
                `- 选项 ${d.option} 没选 → 记为 ${d.ref}（${who(d.owner)}的决定记录）`,
            ),
          ].join("\n"),
        );
      recordNext(
        result.tasks[0]
          ? `看任务：atrium task show ${result.tasks[0].ref}`
          : `看选项单：atrium choice show ${result.choice.ref}`,
      );
    },
  },
  "choice pass": {
    args: "cN [--note 原因]",
    about:
      "这轮都不要：每个选项连同原因记成该节点的决定记录，下一轮产品部读得到，情况没变不重复提",
    options: { note: { type: "string" } },
    positionals: [1, 1],
    async run({ positionals: [ref], values, json }) {
      const result = await (
        await client()
      ).post<Decided>(`/choices/${enc(ref!)}/pass`, {
        ...(str(values, "note") !== undefined
          ? { note: str(values, "note") }
          : {}),
      });
      if (json) printJson(result);
      else
        console.log(
          `${result.choice.ref} 这轮都不要，记了 ${result.decisions.map((d) => d.ref).join("、")}（${who(result.decisions[0]?.owner ?? "secretary")}的决定记录）`,
        );
      recordNext(
        `看决定记录：atrium decision ls${result.decisions[0] && result.decisions[0].owner !== "secretary" ? ` --as ${result.decisions[0].owner}` : ""}`,
      );
    },
  },
  "choice comment": {
    args: "cN 意见 [--prefer 选项号[,选项号]] [--basis 依据]…",
    about:
      "给等拍板的选项单写意见（项目 leader、秘书）：可标倾向哪几个、补依据（fN、tN、dN、链接，可写多次）；拍板人看选项单时一起看到，选中的任务详述也带上",
    options: {
      prefer: { type: "string" },
      basis: { type: "string", multiple: true },
    },
    positionals: [2, 2],
    async run({ positionals: [ref, text], values, json }) {
      const basis = Array.isArray(values.basis)
        ? values.basis.filter((v): v is string => typeof v === "string")
        : [];
      const choice = await (
        await client()
      ).post<Choice>(`/choices/${enc(ref!)}/comment`, {
        text,
        ...(str(values, "prefer") ? { prefer: [str(values, "prefer")] } : {}),
        ...(basis.length ? { basis } : {}),
      });
      if (json) printJson(choice);
      else
        console.log(
          `已给 ${choice.ref} 写意见（共 ${choice.comments.length} 条），拍板人 ${choice.decider}`,
        );
      recordNext(`看全文：atrium choice show ${choice.ref}`);
    },
  },
  "product set": {
    args: "节点 --decider leader|u1",
    about:
      "设谁拍板这个节点（及没另设的下层）上的选项单：u1 用户拍板（缺省），leader 下放给该节点最近的 leader——之后 leader 能 choice pick/pass，用户只收知会；只有用户能改",
    options: { decider: { type: "string" } },
    positionals: [1, 1],
    async run({ positionals: [node], values, json }) {
      const decider = str(values, "decider");
      if (!decider)
        throw new Problem(
          400,
          "--decider: 必填，leader（下放给该节点的 leader）或 u1（用户拍板）",
          "usage",
        );
      const result = await (
        await client()
      ).put<DeciderSetting>(`/product/nodes/${enc(node!)}`, { decider });
      if (json) printJson(result);
      else console.log(settingText(result));
      recordNext(`看选项单：atrium choice ls --node ${result.node}`);
    },
  },
  "product show": {
    args: "节点",
    about:
      "看这个节点上的选项单由谁拍板：本节点的设置（没设就沿用上层，都没设是用户）与实际拍板人",
    positionals: [1, 1],
    async run({ positionals: [node], json }) {
      const result = await (
        await client()
      ).get<DeciderSetting>(`/product/nodes/${enc(node!)}`);
      if (json) printJson(result);
      else console.log(settingText(result));
      recordNext(
        `改拍板人：atrium product set ${result.node} --decider ${result.decider === "u1" ? "leader" : "u1"}`,
      );
    },
  },
  "choice add": {
    args: "节点 --file 选项单.json|- [--task tN]",
    about:
      '产品部提一份选项单挂在节点上（它要演进的那一块），建好叫醒秘书递给用户；文件是 JSON：{"title":"标题","options":[{"title","gain":"能多做到什么","why_now":"为什么现在","cost":"代价：多少活、占哪些额度","skip":"不做会怎样","basis":["f3","t120","d4","链接"]}…3–5 个],"recommend":[选项号],"why":"推荐理由","small":[{"title":"小改进","why":"为什么","basis":["f5"]}…可不写，至多 10 条]}；选项只放大方向，small 是一天内能做完、不改用法的小改进，不进选项单，交该节点最近的 leader 自己定（收 choice_small）；--task 记产出它的研究任务',
    options: { file: { type: "string" }, task: { type: "string" } },
    positionals: [1, 1],
    async run({ positionals: [node], values, json }) {
      const file = str(values, "file");
      if (!file)
        throw new Problem(
          400,
          "--file: 选项单文件必填（JSON，- 为标准输入）",
          "usage",
        );
      const choice = await (
        await client()
      ).post<Choice>("/choices", {
        node,
        choice: readChoiceFile(file),
        ...(str(values, "task") ? { task: str(values, "task") } : {}),
      });
      if (json) printJson(choice);
      else
        console.log(
          `已提 ${choice.ref}「${choice.title}」（${choice.node_alias || choice.node_name}，${choice.options.length} 个选项），已通知秘书`,
        );
      recordNext(`看全文：atrium choice show ${choice.ref}`);
    },
  },
};
