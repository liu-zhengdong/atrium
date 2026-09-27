import type { DatabaseSync } from "node:sqlite";
import { nodeByAddress, nodes, one, ref, type DocRow } from "../org/model.ts";
import { chainPoints } from "../org/points.ts";
import { appliedPoints, resolveApplies } from "../org/aspects.ts";
import { Problem } from "../problem.ts";

/**
 * `atrium map context <节点>`（#322 第 4 步）：从根到本节点的人话链、本块组成、现状与要点，压成一段短文，
 * 派活时附进执行者提示词（与章程要点同一段），让执行者知道自己这块在整体里的位置、必须守住什么。
 *
 * 归属链之外（#373）再附两类别处的要点，各注明来源（「安全 · 适用于网页」）：管方面的部分里适用于本节点的
 * （自动牵涉），以及任务 `--also` 显式牵涉的部分的要点。
 *
 * 有长度上限（缺省 CONTEXT_MAX 字）。超长时按重要程度保留：位置链 > 本块是什么 > 本块要点 > 上级要点（近的先）
 * 与牵涉部分的要点 > 上一层是什么 > 现状与接下来 > 组成 > 更上层是什么；丢掉或截短了就在末尾给全文命令。
 * 纯函数 formatContext 不读库。
 */

export const CONTEXT_MAX = 1500;
export const CONTEXT_MIN = 200;
/** 单条（一句是什么、一条要点）最多占多少字，免得一条挤掉其余。 */
const LINE_MAX = 240;

export type ContextLevel = {
  ref: string;
  name: string;
  alias: string;
  analogy: string;
  what: string;
};
export type ContextPoint = {
  text: string;
  why: string;
  by: string;
  check: string | null;
};
export type ContextInput = {
  /** 根 → 本节点 */
  chain: ContextLevel[];
  parts: { name: string; alias: string; analogy: string }[];
  now: string;
  next: string;
  /** 根 → 本节点，每层的要点；空层可省略。 */
  points: { name: string; points: ContextPoint[] }[];
  /** 归属链之外附进来的要点：来源（「安全 · 适用于网页」）与条目。 */
  applied?: { source: string; points: ContextPoint[] }[];
};
export type Context = {
  ref: string;
  text: string;
  chars: number;
  max: number;
  truncated: boolean;
};

const chars = (text: string) => Array.from(text).length;
function clip(text: string, max: number) {
  const line = text.replace(/\s+/g, " ").trim();
  return chars(line) > max
    ? `${Array.from(line)
        .slice(0, max - 1)
        .join("")}…`
    : line;
}
const label = (l: { name: string; alias: string }) =>
  l.alias && l.alias !== l.name ? `${l.alias}（${l.name}）` : l.name;

export function formatContext(
  input: ContextInput,
  self: string,
  max = CONTEXT_MAX,
): { text: string; truncated: boolean } {
  const more = `…（全文：atrium map context ${self}）`;
  const node = input.chain.at(-1);
  if (!node) return { text: "", truncated: false };
  // [排序键, 优先级（小的先留）, 文本]；排序键决定最终先后。
  const items: { order: number; rank: number; text: string }[] = [];
  let clipped = false;
  const add = (order: number, rank: number, text: string) => {
    const cut = clip(text, LINE_MAX);
    if (cut !== text.replace(/\s+/g, " ").trim()) clipped = true;
    items.push({ order, rank, text: cut });
  };
  add(
    0,
    0,
    `全景位置：${input.chain.map(label).join(" → ")}${node.analogy ? `（${node.analogy}）` : ""}`,
  );
  const depth = input.chain.length;
  input.chain.forEach((level, i) => {
    if (!level.what) return;
    const distance = depth - 1 - i; // 0 = 本节点
    add(
      1 + i,
      distance === 0 ? 1 : distance === 1 ? 4 : 6 + distance,
      `- ${label(level)}：${level.what}`,
    );
  });
  const parts = input.parts.filter((p) => p.alias || p.name);
  if (parts.length)
    add(
      50,
      6,
      `本块由这几部分组成：${parts
        .map((p) => `${label(p)}${p.analogy ? `——${p.analogy}` : ""}`)
        .join("；")}`,
    );
  if (input.now) add(51, 5, `现在：${input.now}`);
  if (input.next) add(52, 5, `接下来：${input.next}`);
  const levels = input.points.filter((l) => l.points.length);
  if (levels.length) {
    add(60, 0, "要点（本节点及上级，必须守住）：");
    levels.forEach((level, i) => {
      const distance = levels.length - 1 - i;
      level.points.forEach((p, j) =>
        add(
          61 + i * 40 + j,
          // 本节点的要点排在上级前；同层按先后。
          2 + distance + j / 100,
          `- [${level.name}] ${p.text}（为什么：${p.why}；${p.by} 定${p.check ? `；检查：${p.check}` : ""}）`,
        ),
      );
    });
  }
  const applied = (input.applied ?? []).filter((l) => l.points.length);
  if (applied.length) {
    add(1000, 0, "牵涉部分的要点（同样必须守住）：");
    applied.forEach((level, i) =>
      level.points.forEach((p, j) =>
        add(
          1001 + i * 40 + j,
          // 与上一层的要点同级：比本块要点低，比更远的上级高。
          3 + i / 10 + j / 100,
          `- [${level.source}] ${p.text}（为什么：${p.why}；${p.by} 定${p.check ? `；检查：${p.check}` : ""}）`,
        ),
      ),
    );
  }
  const budget = max - chars(more) - 1;
  const kept: typeof items = [];
  let used = 0;
  let dropped = false;
  for (const item of [...items].sort(
    (a, b) => a.rank - b.rank || a.order - b.order,
  )) {
    const cost = chars(item.text) + (kept.length ? 1 : 0);
    if (used + cost <= budget) {
      kept.push(item);
      used += cost;
    } else dropped = true;
  }
  // 只剩「要点」标题没有条目时去掉标题。
  const hasPoint = kept.some((k) => k.order > 60 && k.order < 1000);
  const hasApplied = kept.some((k) => k.order > 1000);
  const lines = kept
    .filter(
      (k) => (k.order !== 60 || hasPoint) && (k.order !== 1000 || hasApplied),
    )
    .sort((a, b) => a.order - b.order)
    .map((k) => k.text);
  const truncated = dropped || clipped;
  if (truncated) lines.push(more);
  let text = lines.join("\n");
  // 位置链本身就超长（极端深、极长名字）时硬截。
  if (chars(text) > max)
    text = `${Array.from(text)
      .slice(0, max - chars(more) - 1)
      .join("")}\n${more}`;
  return { text, truncated };
}

const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** 读库拼 context；max 为字数上限，also 为牵涉的部分（`--also o20,o4`）。 */
export function mapContext(
  db: DatabaseSync,
  address: string,
  max = CONTEXT_MAX,
  also?: unknown,
): Context {
  const n = nodeByAddress(db, address);
  return contextOf(db, n.id, max, resolveApplies(db, also, "--also") ?? []);
}

export function contextOf(
  db: DatabaseSync,
  id: number,
  max = CONTEXT_MAX,
  also: readonly number[] = [],
): Context {
  const list = nodes(db);
  const fieldsOf = (nodeId: number): Record<string, unknown> => {
    const doc = one<DocRow>(
      db,
      "SELECT fields FROM org_docs WHERE node_id=? AND doc='charter'",
      nodeId,
    );
    try {
      return doc ? (JSON.parse(doc.fields) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  const chain: ContextLevel[] = [];
  for (let c = list.find((n) => n.id === id); c;) {
    const f = fieldsOf(c.id);
    chain.unshift({
      ref: ref(c.id),
      name: c.name,
      alias: str(f.alias),
      analogy: str(f.analogy),
      what: str(f.what) || str(f.goal),
    });
    const parent: number | null = c.parent_id;
    c = list.find((n) => n.id === parent);
  }
  const own = fieldsOf(id);
  const parts = list
    .filter((n) => n.parent_id === id && n.archived_at === null)
    .map((n) => {
      const f = fieldsOf(n.id);
      return { name: n.name, alias: str(f.alias), analogy: str(f.analogy) };
    });
  const { text, truncated } = formatContext(
    {
      chain,
      parts,
      now: str(own.now),
      next: str(own.next),
      points: chainPoints(db, id).map((level) => ({
        name: level.name,
        points: level.points,
      })),
      applied: appliedPoints(db, id, also),
    },
    ref(id),
    max,
  );
  return { ref: ref(id), text, chars: chars(text), max, truncated };
}

export function parseMax(value: unknown): number {
  if (value === undefined || value === "") return CONTEXT_MAX;
  const n = Number(value);
  if (!Number.isInteger(n) || n < CONTEXT_MIN || n > 8000)
    throw new Problem(
      400,
      `--max 应为 ${CONTEXT_MIN}～8000 的整数字数`,
      "usage",
    );
  return n;
}

/** 派活用：任务归属部分（没有时取负责节点）的 context，带上任务牵涉的部分；节点不在了或没有组织树返回 undefined。 */
export function taskContext(
  db: DatabaseSync,
  id: number | null,
  also: readonly number[] = [],
): string | undefined {
  if (id === null) return undefined;
  try {
    if (!one(db, "SELECT 1 FROM org_nodes WHERE id=?", id)) return undefined;
    return contextOf(db, id, CONTEXT_MAX, also).text || undefined;
  } catch {
    return undefined;
  }
}
