import type { DatabaseSync } from "node:sqlite";
import { formatParam, effective, type EffectiveEntry } from "./boundaries.ts";
import { allBoundaries, chainLevels } from "./boundary-store.ts";
import { nodes, one, ref, type DocRow, type NodeRow } from "./model.ts";

/**
 * 派活提示词里的「章程要点」（#264 4.2）：链路、本节点与父节点目标、整条链的硬边界、记账节点。
 * 整段（含标题）不超过 2000 字；边界由写入校验卡在 1200 字内，永远完整附上，超长时先截父节点目标、再截本节点目标。
 */

export const BRIEF_MAX = 2000;
const chars = (text: string) => Array.from(text).length;
const cut = (text: string, max: number) =>
  Array.from(text).slice(0, Math.max(0, max)).join("");

export type BriefInput = {
  /** 根 → 本节点的显示名 */
  chain: string[];
  node: { ref: string; name: string; goal: string };
  parent?: { name: string; goal: string };
  boundaries: Pick<EffectiveEntry, "summary" | "param">[];
};
export type Brief = { heading: string; text: string };

export function formatBrief({
  chain,
  node,
  parent,
  boundaries,
}: BriefInput): Brief {
  const heading = `章程要点（${chain.join(" → ")}）`;
  const more = `…（全文：atrium org show ${node.ref}）`;
  const lines = boundaries.map(
    (e) => `- ${e.summary}${e.param ? `：${formatParam(e.param)}` : ""}`,
  );
  const tail = [
    ...(lines.length
      ? ["硬边界（任何情况都不能放开）：", ...lines]
      : ["硬边界：无"]),
    `预算：本任务记在 ${node.name}（${node.ref}）账上。`,
    "碰到边界或预算不够：停下，在结果里写「需要上层决定：……」，不要绕过。",
  ];
  const goalLine = (parentGoal: string, ownGoal: string) => {
    const parts = [
      ...(parent && parentGoal ? [`${parent.name}——${parentGoal}`] : []),
      ...(ownGoal ? [`${node.name}——${ownGoal}`] : []),
    ];
    return parts.length ? [`目标：${parts.join("；")}`] : [];
  };
  const assemble = (parentGoal: string, ownGoal: string) =>
    [...goalLine(parentGoal, ownGoal), ...tail].join("\n");
  const size = (text: string) => chars(heading) + chars(text);
  // 目标之间用「；」连接，去掉各自句末的句号免得出现「。；」
  const clean = (goal: string) => goal.trim().replace(/[。.]+$/, "");
  let parentGoal = clean(parent?.goal ?? "");
  let ownGoal = clean(node.goal);
  let text = assemble(parentGoal, ownGoal);
  if (size(text) > BRIEF_MAX && parentGoal) {
    const over = size(text) - BRIEF_MAX;
    const keep = chars(parentGoal) - over - chars(more);
    parentGoal = keep > 0 ? cut(parentGoal, keep) + more : "";
    text = assemble(parentGoal, ownGoal);
  }
  if (size(text) > BRIEF_MAX && ownGoal) {
    const over = size(text) - BRIEF_MAX;
    const keep = chars(ownGoal) - over - chars(more);
    ownGoal = keep > 0 ? cut(ownGoal, keep) + more : "";
    text = assemble(parentGoal, ownGoal);
  }
  return { heading, text };
}

const goalOf = (db: DatabaseSync, id: number) => {
  const doc = one<DocRow>(
    db,
    "SELECT * FROM org_docs WHERE node_id=? AND doc='charter'",
    id,
  );
  if (!doc) return "";
  const goal = (JSON.parse(doc.fields) as { goal?: unknown }).goal;
  return typeof goal === "string" ? goal : "";
};

/** 读库拼本节点的章程要点；节点不存在返回 undefined。 */
export function charterBrief(db: DatabaseSync, id: number): Brief | undefined {
  const list = nodes(db);
  const node = list.find((n) => n.id === id);
  if (!node) return undefined;
  const chain: NodeRow[] = [];
  let current: NodeRow | undefined = node;
  while (current) {
    chain.unshift(current);
    const parentId: number | null = current.parent_id;
    current = list.find((n) => n.id === parentId);
  }
  const owned = allBoundaries(db);
  const levels = [
    ...chainLevels(list, owned, node.parent_id),
    { node: node.id, name: node.name, entries: owned.get(node.id) ?? [] },
  ];
  const parent = list.find((n) => n.id === node.parent_id);
  return formatBrief({
    chain: chain.map((n) => n.name),
    node: { ref: ref(node.id), name: node.name, goal: goalOf(db, node.id) },
    ...(parent
      ? { parent: { name: parent.name, goal: goalOf(db, parent.id) } }
      : {}),
    boundaries: effective(levels),
  });
}

/**
 * 章程要点与全景位置（#322 第 4 步，`map context`）合成同一段：全景位置与要点在前，章程目标与硬边界在后。
 * 章程要点自己不超过 BRIEF_MAX，全景段不超过 CONTEXT_MAX，整段不超过两者之和。
 */
export function withContext(
  brief: Brief | undefined,
  context: string | undefined,
): Brief | undefined {
  if (!context) return brief;
  if (!brief) return { heading: "全景位置与要点", text: context };
  return { heading: brief.heading, text: `${context}\n\n${brief.text}` };
}
