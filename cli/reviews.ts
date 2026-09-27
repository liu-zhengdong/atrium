import { briefInput } from "./brief-input.ts";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Problem } from "../server/problem.ts";
import { STANCE_LABEL } from "../server/tasks/council-gate.ts";
import type { CouncilView } from "../server/tasks/councils.ts";
import { recordNext } from "./contract.ts";
import { printJson } from "./format.ts";
import type { Command, Values } from "./main.ts";

/** 会审（#322 第 3 步）的命令行：发起、看各方意见与结论、对上交的事拍板。只经 HTTP 调服务。 */

const str = (values: Values, key: string) => {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
};
const client = async () => (await import("./service.ts")).connect();

function ref(value: string | undefined) {
  if (!value || !/^t[1-9][0-9]*$/.test(value))
    throw new Problem(
      400,
      `会审用议题任务的短号，如 t1（收到：${value ?? "空"}）`,
      "usage",
      undefined,
      "atrium task ls",
    );
  return value;
}

function existing(value: string, flag: string, kind: "file" | "directory") {
  const path = resolve(value);
  const stat = existsSync(path) ? statSync(path) : null;
  if (!stat || (kind === "file" ? !stat.isFile() : !stat.isDirectory()))
    throw new Problem(
      400,
      `${flag} 指向的${kind === "file" ? "文件" : "目录"}不存在：${path}`,
      "usage",
    );
  return path;
}

const indent = (text: string) =>
  text
    .trim()
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");

/** 会审全貌：议题、各方意见（原文）、汇总的一致与冲突、结论与需用户拍板。 */
export function renderCouncil(view: CouncilView, full = true): string {
  const lines = [
    `会审 ${view.ref}：${view.topic}`,
    `阶段：${view.stage_label}${view.status === "failed" || view.status === "blocked" ? `（汇总任务 ${view.status === "failed" ? "失败" : "受阻"}，看 atrium task show ${view.ref}）` : ""}`,
    `汇总与拍板：${view.leader ? `${view.leader.name}（${view.leader.ref}）的 leader` : "秘书"}${view.issue ? ` · issue #${view.issue}${view.comment ? "（结论同步为评论）" : ""}` : ""}`,
    "",
    "各方意见：",
    ...view.opinions.flatMap((o) => [
      `  ${o.name}（${o.ref} · ${o.task}）：${STANCE_LABEL[o.stance]}${o.reason ? `——${o.reason}` : ""}`,
      ...(full && o.text?.trim() ? [indent(o.text)] : []),
    ]),
  ];
  if (view.stage === "decided" || view.stage === "escalated") {
    lines.push("", `汇总（${view.summary.task}）：`);
    if (view.agreed.length)
      lines.push("  一致：", ...view.agreed.map((a) => `    - ${a}`));
    if (view.conflicts.length)
      lines.push("  冲突：", ...view.conflicts.map((c) => `    - ${c}`));
    if (full && view.summary.text?.trim() && !view.agreed.length)
      lines.push(indent(view.summary.text));
    lines.push(`结论：${view.conclusion ?? "（leader 没写结论）"}`);
    if (view.decided_by && view.decided_by !== "leader")
      lines.push(`拍板：${view.decided_by}`);
    if (view.escalate.length)
      lines.push(
        view.stage === "escalated" ? "需用户拍板：" : "曾上交用户：",
        ...view.escalate.map((e) => `  - ${e}`),
      );
  }
  return lines.join("\n");
}

const add: Command = {
  args: "议题 --concerns 专员[,专员] [--brief 文件|-] [--issue 号] [--leader 节点] [--repo 路径] [--comment] [--part 节点] [--owner 订阅者]",
  about:
    "发起会审：并行给每位受邀专员派一个一次性执行者按各自章程与清单出意见，收齐后 leader（--leader 节点，缺省秘书）汇总一致与冲突、能定的定，碰到用户边界或谈不拢的标「需用户拍板」投事件；结论记在议题上，--comment 同步为 --issue 的评论",
  options: {
    concerns: { type: "string" },
    brief: { type: "string" },
    issue: { type: "string" },
    leader: { type: "string" },
    repo: { type: "string" },
    comment: { type: "boolean" },
    part: { type: "string" },
    owner: { type: "string" },
  },
  positionals: [1, 1],
  async run({ positionals: [topic], values, json }) {
    if (!topic?.trim())
      throw new Problem(
        400,
        "议题不能为空",
        "usage",
        undefined,
        "atrium review add 议题 --concerns 前端,后端",
      );
    const concerns = str(values, "concerns");
    if (!concerns?.trim())
      throw new Problem(
        400,
        "--concerns 至少请一位专员，如 前端,后端",
        "usage",
        undefined,
        "atrium org tree",
      );
    const issueText = str(values, "issue");
    let issue: number | undefined;
    if (issueText !== undefined) {
      issue = Number(issueText);
      if (!/^[1-9][0-9]*$/.test(issueText) || !Number.isSafeInteger(issue))
        throw new Problem(400, "--issue 应为正整数 issue 号", "usage");
    }
    const repo = str(values, "repo");
    const brief = str(values, "brief");
    if (values.comment === true && (issue === undefined || repo === undefined))
      throw new Problem(
        400,
        "--comment 需同时给 --issue <号> 与 --repo <仓库>",
        "usage",
      );
    const body = {
      topic,
      concerns,
      ...(brief === undefined
        ? {}
        : await briefInput(brief, (path) => existing(path, "--brief", "file"))),
      ...(issue === undefined ? {} : { issue }),
      ...(str(values, "leader") === undefined
        ? {}
        : { leader: str(values, "leader") }),
      ...(repo === undefined
        ? {}
        : { repo: existing(repo, "--repo", "directory") }),
      ...(values.comment === true ? { comment: true } : {}),
      ...(str(values, "part") === undefined
        ? {}
        : { part: str(values, "part") }),
      ...(str(values, "owner") === undefined
        ? {}
        : { owner: str(values, "owner") }),
    };
    const view = await (await client()).post<CouncilView>("/reviews", body);
    if (json) printJson(view);
    else
      console.log(
        [
          `已发起会审 ${view.ref}：${view.topic}`,
          ...view.opinions.map(
            (o) =>
              `  ${o.name}（${o.ref}）出意见：${o.task} ${o.status === "running" ? "已派" : o.status === "blocked" ? `拉不起来：${o.reason}` : o.status === "todo" ? "排队" : o.status}`,
          ),
          `意见收齐后由${view.leader ? `${view.leader.name}（${view.leader.ref}）的 leader` : "秘书"}汇总，结论与「需用户拍板」投事件`,
        ].join("\n"),
      );
    recordNext(
      `等结论：atrium task wait ${view.ref}；看意见与结论：atrium review show ${view.ref}`,
    );
  },
};

const show: Command = {
  args: "tN [--brief]",
  about:
    "看会审：各方意见（立场与原文）、汇总的一致与冲突、结论、需用户拍板的事；--brief 只列立场不带原文",
  options: { brief: { type: "boolean", default: false } },
  positionals: [1, 1],
  async run({ positionals: [reference], values, json }) {
    const id = ref(reference);
    const view = await (await client()).get<CouncilView>(`/reviews/${id}`);
    if (json) printJson(view);
    else console.log(renderCouncil(view, values.brief !== true));
    recordNext(
      view.stage === "escalated"
        ? `用户拍板后记下：atrium review decide ${id} 结论`
        : view.stage === "decided"
          ? `按结论建后续任务：atrium task add 标题 --parent ${id}`
          : `等结论：atrium task wait ${id}`,
    );
  },
};

const decide: Command = {
  args: "tN 结论 [--as 拍板人]",
  about:
    "记下对会审的拍板（多用于「需用户拍板」的会审）：阶段转已定，原上交事项保留；--as 缺省 u1",
  options: { as: { type: "string" } },
  positionals: [2, 2],
  async run({ positionals: [reference, conclusion], values, json }) {
    const id = ref(reference);
    if (!conclusion?.trim()) throw new Problem(400, "结论不能为空", "usage");
    const who = str(values, "as") ?? "u1";
    if (!who.trim()) throw new Problem(400, "--as 不能为空", "usage");
    const view = await (
      await client()
    ).post<CouncilView>(
      `/reviews/${id}/decide?${new URLSearchParams({ as: who })}`,
      { conclusion },
    );
    if (json) printJson(view);
    else console.log(`已记下 ${id} 的结论（${who} 拍板）：${view.conclusion}`);
    recordNext(`按结论建后续任务：atrium task add 标题 --parent ${id}`);
  },
};

export const reviewCommands: Record<string, Command> = {
  "review add": add,
  "review show": show,
  "review decide": decide,
};
