import { readFileSync } from "node:fs";
import { Problem } from "../server/problem.ts";
import type { PlanView } from "../server/plans/store.ts";
import type { PlanStarted } from "../server/plans/runtime.ts";
import { suggestedWorker } from "../server/plans/model.ts";
import { recordNext } from "./contract.ts";
import { printJson } from "./format.ts";
import type { Command, Values } from "./main.ts";

/**
 * 规划任务（t275）：`task plan-for` 派一个执行者读代码与总任务详述、出子任务清单（不改代码）；
 * `task adopt-plan --dry-run` 看清单，`task adopt-plan` 按清单批量建子任务、设依赖、就绪的自动派出，
 * `--file` 用改过的清单；`task reject-plan` 驳回。
 */

const str = (values: Values, key: string) =>
  typeof values[key] === "string" ? (values[key] as string) : undefined;
const client = async () => (await import("./service.ts")).connect();
const enc = encodeURIComponent;

const STATUS: Record<PlanView["status"], string> = {
  planning: "还在规划",
  failed: "没出清单",
  ready: "清单待采纳",
  adopted: "已采纳",
  rejected: "已驳回",
};

/** 清单的文字版：状态、整体思路、每件按先后（代号、标题、依赖、建议的专员与执行者、归属），采纳后给建出的任务。 */
export function renderPlan(view: PlanView): string[] {
  const head = `${view.plan} 规划 ${view.target}「${view.target_title}」 · ${STATUS[view.status]}${view.decided_by ? `（${view.decided_by}）` : ""}`;
  const lines = [head];
  if (view.error) lines.push(`原因：${view.error}`);
  if (view.note) lines.push(`驳回说明：${view.note}`);
  const plan = view.content;
  if (!plan) return lines;
  if (plan.summary) lines.push(`思路：${plan.summary}`);
  const made = new Map(view.adopted.map((a) => [a.key, a.ref]));
  for (const [index, item] of plan.tasks.entries()) {
    const extra = [
      `${item.size}`,
      item.after.length
        ? `等 ${item.after.map((k) => made.get(k) ?? k).join("、")}`
        : "",
      item.by ? `专员 ${item.by}` : "",
      item.ask.length ? `请审 ${item.ask.join("、")}` : "",
      `建议 ${suggestedWorker(item)}`,
      item.part ? `归属 ${item.part}` : "",
    ].filter(Boolean);
    lines.push(
      `${index + 1}. [${made.get(item.key) ?? item.key}] ${item.title}${extra.length ? `（${extra.join("；")}）` : ""}`,
      ...item.brief
        .split("\n")
        .slice(0, 6)
        .map((line) => `   ${line}`),
    );
  }
  return lines;
}

function readPlanFile(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Problem(400, `--file: 读不到 ${file}`, "usage");
  }
  try {
    const value = JSON.parse(text.replace(/^﻿/, "")) as unknown;
    // --dry-run --json 存下来的整份回执也认：取里面的清单。
    if (
      value &&
      typeof value === "object" &&
      "result" in value &&
      (value as { result?: { content?: unknown } }).result?.content
    )
      return (value as { result: { content: unknown } }).result.content;
    if (value && typeof value === "object" && "content" in value)
      return (value as { content: unknown }).content;
    return value;
  } catch {
    throw new Problem(400, `--file: ${file} 不是合法的 JSON`, "usage");
  }
}

export const planCommands: Record<string, Command> = {
  "task plan-for": {
    args: "tN [--worker 工具+模型[:强度]]",
    about:
      "给总任务派规划任务：一次性执行者读代码与详述，写出子任务清单（标题、详述要点、先后依赖、大小、建议的专员与执行者、归属部分；每件约半小时交付，小的建议快的执行者、中大的建议强的），不改代码、不开 PR；清单好了负责的 leader 收到「规划待采纳」。选项单拍板建的总任务运行时已自动派；已有没了结的规划时报冲突",
    options: { worker: { type: "string" } },
    positionals: [1, 1],
    async run({ positionals: [task], values, json }) {
      const result = await (
        await client()
      ).post<PlanStarted>(`/tasks/${enc(task!)}/plan`, {
        ...(str(values, "worker") ? { worker: str(values, "worker") } : {}),
      });
      if (json) printJson(result);
      else
        console.log(
          result.run_error
            ? `规划任务 ${result.task.ref} 已建好，但没派出去：${result.run_error}`
            : `规划任务 ${result.task.ref} 已${result.queued ? "排队" : "启动"}：给 ${result.target} 出子任务清单，不改代码`,
        );
      recordNext(result.next);
    },
  },
  "task adopt-plan": {
    args: "tM [--dry-run] [--file 清单.json]",
    about:
      "采纳规划：按清单在总任务下批量建子任务（详述带来源、大小、建议的专员、先后依赖，开自动派），就绪的由排期自动派出、先试规划建议的执行者；--dry-run 只看清单不建；--file 用改过的清单（格式同 --dry-run --json 的 content，整份回执也认）；tM 给总任务时取它最近的规划；一件建不起来整批不建；同一份只采纳一次",
    options: { "dry-run": { type: "boolean" }, file: { type: "string" } },
    positionals: [1, 1],
    async run({ positionals: [task], values, json }) {
      const file = str(values, "file");
      const plan = file === undefined ? undefined : readPlanFile(file);
      const api = await client();
      const view =
        values["dry-run"] === true && plan === undefined
          ? await api.get<PlanView>(`/plans/${enc(task!)}`)
          : await api.post<PlanView>(`/plans/${enc(task!)}/adopt`, {
              ...(plan === undefined ? {} : { plan }),
              ...(values["dry-run"] === true ? { dry_run: true } : {}),
            });
      if (json) printJson(view);
      else if (view.dry_run) console.log(renderPlan(view).join("\n"));
      else
        console.log(
          [
            `已采纳 ${view.plan}：在 ${view.target} 下建了 ${view.adopted.length} 件子任务（就绪的由排期自动派出）`,
            ...view.adopted.map(
              (a) =>
                `- ${a.ref} ${a.title}（${[a.size, a.worker ? `先试 ${a.worker}` : "", a.after.length ? `等 ${a.after.join("、")}` : ""].filter(Boolean).join("；")}）`,
            ),
          ].join("\n"),
        );
      recordNext(
        !view.dry_run
          ? `看进度：atrium task tree ${view.target}`
          : view.status === "ready"
            ? `采纳：atrium task adopt-plan ${view.plan}${file ? ` --file ${file}` : ""}；不合适：atrium task reject-plan ${view.plan} --note 原因`
            : view.status === "planning"
              ? `等清单：atrium task wait ${view.plan}`
              : view.status === "failed"
                ? `重新规划：atrium task plan-for ${view.target}`
                : `看进度：atrium task tree ${view.target}`,
      );
    },
  },
  "task reject-plan": {
    args: "tM --note 原因",
    about:
      "驳回规划：写明原因（下次规划照着改）；要重来再 task plan-for 总任务，可先 task tell 捎话补充",
    options: { note: { type: "string" } },
    positionals: [1, 1],
    async run({ positionals: [task], values, json }) {
      const note = str(values, "note");
      if (!note?.trim())
        throw new Problem(
          400,
          "--note 必填：写明为什么驳回（下次规划照着改）",
          "usage",
        );
      const view = await (
        await client()
      ).post<PlanView>(`/plans/${enc(task!)}/reject`, { note });
      if (json) printJson(view);
      else console.log(`已驳回 ${view.plan}（${view.target}）：${view.note}`);
      recordNext(`重新规划：atrium task plan-for ${view.target}`);
    },
  },
};
