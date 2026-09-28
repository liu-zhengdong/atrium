import type { DatabaseSync } from "node:sqlite";
import { nodeByAddress, one, ref } from "../org/model.ts";
import { chainPoints } from "../org/points.ts";
import { skillsForTask } from "../skills/task-skills.ts";
import { Problem } from "../problem.ts";

/**
 * `atrium map context <部分>`：派活与 leader 唤醒附带的一段——从根到这一部分链上的要点（规矩），按树从上到下、
 * 同一层按排序（靠前的更重要，冲突时靠前的优先），再加用到的技能清单。只附这些，有字数上限；
 * 放不下时从链的末端往前截，末尾给全文命令。纯函数 formatContext 不读库。
 */

export const CONTEXT_MAX = 1500;
export const CONTEXT_MIN = 200;
/** 一条要点里「为什么」最多占多少字，免得一条挤掉其余；整段放不下时先去掉「为什么」。 */
const WHY_MAX = 40;

export type ContextPoint = { text: string; why: string; check: string | null };
export type ContextInput = {
  /** 根 → 本部分，每层的要点；空层可省略。 */
  points: { name: string; points: ContextPoint[] }[];
  /** 用到的技能（slug）。 */
  skills?: string[];
};
export type Context = {
  ref: string;
  text: string;
  chars: number;
  max: number;
  truncated: boolean;
};

const chars = (text: string) => Array.from(text).length;
const clip = (text: string, max: number) => {
  const line = text.replace(/\s+/g, " ").trim();
  return chars(line) > max
    ? `${Array.from(line)
        .slice(0, max - 1)
        .join("")}…`
    : line;
};

export function formatContext(
  input: ContextInput,
  self: string,
  max = CONTEXT_MAX,
): { text: string; truncated: boolean } {
  const full = fit(input, self, max, true);
  return full.truncated ? fit(input, self, max, false) : full;
}

function fit(
  input: ContextInput,
  self: string,
  max: number,
  why: boolean,
): { text: string; truncated: boolean } {
  const more = `…（全文：atrium map context ${self}）`;
  const lines: string[] = [];
  const levels = input.points.filter((l) => l.points.length);
  if (levels.length) {
    lines.push("规矩（从上到下越靠前越重要，冲突时靠前的优先）：");
    for (const level of levels) {
      lines.push(`[${level.name}]`);
      level.points.forEach((p, i) =>
        lines.push(
          `${i + 1}. ${p.text}${why ? `（${clip(p.why, WHY_MAX)}）` : ""}${p.check ? `（检查：${clip(p.check, WHY_MAX)}）` : ""}`,
        ),
      );
    }
  }
  if (input.skills?.length)
    lines.push(`技能：${input.skills.join("、")}（派活时已挂载）`);
  const whole = lines.join("\n");
  if (chars(whole) <= max) return { text: whole, truncated: false };
  const budget = max - chars(more) - 1;
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = chars(line) + (kept.length ? 1 : 0);
    if (used + cost > budget) break;
    kept.push(line);
    used += cost;
  }
  kept.push(more);
  return { text: kept.join("\n"), truncated: true };
}

/** 读库拼 context；skills 给了就用（派活时是实际挂载的），没给按部分链上绑定的技能。 */
export function contextOf(
  db: DatabaseSync,
  id: number,
  max = CONTEXT_MAX,
  skills?: string[],
): Context {
  const { text, truncated } = formatContext(
    {
      points: chainPoints(db, id).map((level) => ({
        name: level.name,
        points: level.points,
      })),
      skills:
        skills ??
        skillsForTask(db, { part_id: id, node_id: null }).skills.map(
          (s) => s.slug,
        ),
    },
    ref(id),
    max,
  );
  return { ref: ref(id), text, chars: chars(text), max, truncated };
}

export function mapContext(
  db: DatabaseSync,
  address: string,
  max = CONTEXT_MAX,
): Context {
  return contextOf(db, nodeByAddress(db, address).id, max);
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

/** 派活用：任务归属部分链上的要点（技能另有「本次挂载的技能」一段，这里不重复）；没有组织树返回 undefined。 */
export function taskContext(
  db: DatabaseSync,
  id: number | null,
): string | undefined {
  if (id === null) return undefined;
  try {
    if (!one(db, "SELECT 1 FROM org_nodes WHERE id=?", id)) return undefined;
    return contextOf(db, id, CONTEXT_MAX, []).text || undefined;
  } catch {
    return undefined;
  }
}
