import { resolve } from "node:path";
import type { DraftView } from "../server/drafts/store.ts";
import type { Change } from "../server/drafts/plan.ts";
import { recordNext } from "./contract.ts";
import { printJson } from "./format.ts";
import type { Command, Values } from "./main.ts";

/**
 * 从仓库起草全景初稿（t186）：`map draft` 派一次性执行者只读仓库、起草这一块的人话字段；
 * `map apply --dry-run` 给你看初稿与会改什么，`map apply --node` 确认后才写进组织树。
 */

const str = (values: Values, key: string) =>
  typeof values[key] === "string" ? (values[key] as string) : undefined;
const client = async () => (await import("./service.ts")).connect();
const enc = encodeURIComponent;

const LABEL: Record<Change["field"], string> = {
  alias: "人话名",
  analogy: "类比",
  what: "是什么",
  uses: "能用它做什么",
  flow: "一件事怎么走完",
};

/** 初稿的文字版：先状态，再人话字段，最后写进节点会改什么（纯函数）。 */
export function renderDraft(view: DraftView): string[] {
  const head = `${view.task} 全景初稿 · 读自 ${view.repo}`;
  if (view.status === "drafting") return [`${head} · 还在起草`];
  if (!view.draft)
    return [`${head} · 没有可用的初稿`, `原因：${view.error ?? "未知"}`];
  const d = view.draft;
  const lines = [
    `${head} · ${view.status === "applied" ? `已写进 ${view.node}` : "待你确认"}`,
    ...(d.name ? [`名称：${d.name}`] : []),
    ...(d.alias ? [`人话名：${d.alias}`] : []),
    ...(d.analogy ? [`类比：${d.analogy}`] : []),
    `是什么：${d.what}`,
    "能用它做什么：",
    ...d.uses.map((u) => `  - ${u}`),
    "一件事怎么走完：",
    ...d.flow.map((s, i) => `  ${i + 1}. ${s}`),
  ];
  if (d.parts.length)
    lines.push(
      "由哪几部分组成（建节点时用，这次不写）：",
      ...d.parts.map(
        (p) => `  - ${p.name}${p.analogy ? `——${p.analogy}` : ""}`,
      ),
    );
  if (view.status === "applied") return lines;
  if (!view.node) lines.push("", "还没定写到哪个节点：用 --node 指定");
  else if (!view.changes?.length)
    lines.push("", `写进 ${view.node} ${view.node_name}：和现在一样，不会改动`);
  else
    lines.push(
      "",
      `写进 ${view.node} ${view.node_name} 会改：${view.changes
        .map(
          (c) =>
            `${LABEL[c.field]}（${c.before === null ? "原来没写" : "覆盖原来的"}）`,
        )
        .join("、")}`,
    );
  return lines;
}

type Started = {
  repo: string;
  task: { ref: string };
  queued?: boolean;
  run_error?: string;
  next?: string;
};

export const draftCommands: Record<string, Command> = {
  "map draft": {
    args: "仓库路径 [--node 节点] [--worker 工具+模型[:强度]]",
    about:
      "从本机仓库起草一块的全景初稿：运行时先读 README、两层目录与最近提交（跳过隐藏与像凭据的文件），派一次性执行者只读仓库、看开着的 issue，写出是什么、能做什么、怎么走完、由哪几部分组成；不改仓库、不推送。初稿先给你看（map apply --dry-run），确认才写进组织树；--node 是要写到的节点",
    options: { node: { type: "string" }, worker: { type: "string" } },
    positionals: [1, 1],
    async run({ positionals: [repo], values, json }) {
      const result = await (
        await client()
      ).post<Started>("/drafts", {
        repo: resolve(repo!),
        ...(str(values, "node") ? { node: str(values, "node") } : {}),
        ...(str(values, "worker") ? { worker: str(values, "worker") } : {}),
      });
      const ref = result.task.ref;
      if (json) printJson(result);
      else
        console.log(
          result.run_error
            ? `${ref} 已建好，但没派出去：${result.run_error}`
            : `${ref} 起草已${result.queued ? "排队" : "启动"}：读 ${result.repo}；执行者只读仓库，初稿要你确认才写进全景图`,
        );
      recordNext(
        result.run_error
          ? (result.next ?? `atrium task run ${ref}`)
          : `等初稿：atrium task wait ${ref}，再 atrium map apply ${ref} --dry-run 看`,
      );
    },
  },
  "map apply": {
    args: "起草任务 [--node 节点] [--dry-run]",
    about:
      "看或确认全景初稿：--dry-run 只打出初稿和写进节点会改哪些字段；不带就把人话名、类比、是什么、能做什么、怎么走完写进 --node（缺省是起草时给的节点），没给的字段不动，组成部分留给建节点；同一份初稿只写一次",
    options: { node: { type: "string" }, "dry-run": { type: "boolean" } },
    positionals: [1, 1],
    async run({ positionals: [task], values, json }) {
      const node = str(values, "node");
      const api = await client();
      const view =
        values["dry-run"] === true
          ? await api.get<DraftView>(
              `/drafts/${enc(task!)}${node ? `?node=${enc(node)}` : ""}`,
            )
          : await api.post<DraftView>(`/drafts/${enc(task!)}/apply`, {
              ...(node ? { node } : {}),
            });
      if (json) printJson(view);
      else if (view.dry_run) console.log(renderDraft(view).join("\n"));
      else
        console.log(
          `已把 ${view.task} 的初稿写进 ${view.node} ${view.node_name}：${
            view.changes?.length
              ? `改了${view.changes.map((c) => LABEL[c.field]).join("、")}`
              : "和原来一样，没有改动"
          }${view.draft?.parts.length ? `；组成部分 ${view.draft.parts.length} 块没写，建节点时用` : ""}`,
        );
      recordNext(
        !view.dry_run || view.status === "applied"
          ? `看全景：atrium map ${view.node}`
          : view.status === "drafting"
            ? `等初稿：atrium task wait ${view.task}`
            : view.status === "failed"
              ? `重新起草：atrium map draft ${view.repo}${view.node ? ` --node ${view.node}` : ""}`
              : `确认写入：atrium map apply ${view.task} --node ${view.node ?? "节点"}`,
      );
    },
  },
};
