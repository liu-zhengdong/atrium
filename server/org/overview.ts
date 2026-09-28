import { hasParentSegment, isAbsolutePath } from "../platform/plan.ts";
import { Problem } from "../problem.ts";

/**
 * 全景图的人话字段（#322 第 1 步）：写在节点章程当前字段里，不留修订历史，按章程权限改。
 * 顺序即 `org show` 的讲法：是什么 → 能用它做什么 → 一件事怎么走完 → 由哪几部分组成 → 现在做到哪、接下来做什么。
 * 组成部分不单写：取子节点，各自章程里的 alias（人话名）与 analogy（类比）。技术细节是章程正文，默认折叠。
 * 阶段记录（stages）在章程里直接改（旧的 g 短号留作 id）。纯函数，不读库。
 */

export const STAGE_STATUSES = [
  "planned",
  "active",
  "achieved",
  "blocked",
  "dropped",
] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];
export const STAGE_LABEL: Record<StageStatus, string> = {
  planned: "规划中",
  active: "进行中",
  achieved: "达成",
  blocked: "受阻",
  dropped: "放弃",
};

export type Stage = {
  id: string;
  result: string;
  status: StageStatus;
  criteria?: string[];
  evidence?: string[];
  note?: string;
  due?: string;
  after?: string[];
  parent?: string;
  repo?: string;
};

/** 人话字段：文本上限（字）。 */
export const OVERVIEW_TEXT: Record<string, number> = {
  what: 300,
  alias: 40,
  analogy: 100,
  now: 500,
  next: 500,
};
/** 人话字段：列表上限（项）与每项上限 300 字。 */
export const OVERVIEW_LISTS: Record<string, number> = { uses: 10, flow: 12 };
export const STAGES_MAX = 60;

const bad = (field: string, message: string): never => {
  throw new Problem(400, `${field} ${message}`, "usage");
};
const text = (value: unknown, field: string, max: number) => {
  if (typeof value !== "string") return bad(field, "应为文本");
  if (Array.from(value).length > max) bad(field, `超过 ${max} 字`);
  return value;
};
const texts = (value: unknown, field: string, count: number, max: number) => {
  if (!Array.isArray(value)) return bad(field, "应为文本列表");
  if (value.length > count) bad(field, `超过 ${count} 项`);
  value.forEach((item, i) => text(item, `${field}[${i}]`, max));
  return value as string[];
};
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 校验 charter.stages；返回原值（字段顺序由写入方决定）。 */
export function validateStages(value: unknown, field = "charter.stages") {
  if (!Array.isArray(value)) return bad(field, "应为阶段列表");
  if (value.length > STAGES_MAX) bad(field, `超过 ${STAGES_MAX} 项`);
  const ids = new Set<string>();
  value.forEach((item, i) => {
    const at = `${field}[${i}]`;
    if (!item || typeof item !== "object" || Array.isArray(item))
      return bad(at, "应为对象");
    const stage = item as Record<string, unknown>;
    for (const key of Object.keys(stage))
      if (
        ![
          "id",
          "result",
          "status",
          "criteria",
          "evidence",
          "note",
          "due",
          "after",
          "parent",
          "repo",
        ].includes(key)
      )
        bad(`${at}.${key}`, "是未知字段");
    const id = text(stage.id, `${at}.id`, 40).trim();
    if (!id) bad(`${at}.id`, "不能为空");
    if (ids.has(id)) bad(`${at}.id`, `与前面的阶段重复：${id}`);
    ids.add(id);
    if (!text(stage.result, `${at}.result`, 300).trim())
      bad(`${at}.result`, "不能为空");
    if (!STAGE_STATUSES.includes(stage.status as StageStatus))
      bad(`${at}.status`, `只能是 ${STAGE_STATUSES.join("、")}`);
    if (stage.criteria !== undefined)
      texts(stage.criteria, `${at}.criteria`, 20, 500);
    if (stage.evidence !== undefined)
      texts(stage.evidence, `${at}.evidence`, 20, 1000);
    if (stage.after !== undefined) texts(stage.after, `${at}.after`, 20, 40);
    if (stage.note !== undefined) text(stage.note, `${at}.note`, 500);
    if (stage.parent !== undefined) text(stage.parent, `${at}.parent`, 40);
    if (
      stage.repo !== undefined &&
      (!isAbsolutePath(process.platform, text(stage.repo, `${at}.repo`, 500)) ||
        hasParentSegment(process.platform, stage.repo as string))
    )
      bad(`${at}.repo`, "应为绝对路径，不能包含 ..");
    if (
      stage.due !== undefined &&
      (typeof stage.due !== "string" ||
        !DATE.test(stage.due) ||
        Number.isNaN(Date.parse(stage.due)) ||
        new Date(stage.due).toISOString().slice(0, 10) !== stage.due)
    )
      bad(`${at}.due`, "应为 YYYY-MM-DD 日期");
  });
  return value as Stage[];
}

/** 章程字段里的一项若是人话字段就校验并返回 true；不是返回 false，交给原有规则。 */
export function validateOverviewField(key: string, value: unknown): boolean {
  const field = `charter.${key}`;
  if (Object.hasOwn(OVERVIEW_TEXT, key))
    text(value, field, OVERVIEW_TEXT[key]!);
  else if (Object.hasOwn(OVERVIEW_LISTS, key))
    texts(value, field, OVERVIEW_LISTS[key]!, 300);
  else if (key === "stages") validateStages(value, field);
  else return false;
  return true;
}

export type Part = {
  ref: string;
  name: string;
  alias: string;
  analogy: string;
  archived: boolean;
  tasks: {
    todo: number;
    running: number;
    blocked: number;
    reviewing?: number;
    merge_queued?: number;
    merging?: number;
  };
};
export type Overview = {
  alias: string;
  analogy: string;
  what: string;
  /** what 没写时取章程目标兜底。 */
  what_from_goal: boolean;
  uses: string[];
  flow: string[];
  parts: Part[];
  now: string;
  next: string;
  stages: Stage[];
};

const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const list = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && !!v.trim())
    : [];

/** 读章程字段拼人话视图；字段坏了（旧数据）按没写处理，不挡读取。 */
export function overviewOf(
  fields: Record<string, unknown>,
  parts: Part[],
): Overview {
  const what = str(fields.what);
  const goal = str(fields.goal);
  let stages: Stage[] = [];
  try {
    stages = fields.stages === undefined ? [] : validateStages(fields.stages);
  } catch {
    stages = [];
  }
  return {
    alias: str(fields.alias),
    analogy: str(fields.analogy),
    what: what || goal,
    what_from_goal: !what && !!goal,
    uses: list(fields.uses),
    flow: list(fields.flow),
    parts,
    now: str(fields.now),
    next: str(fields.next),
    stages,
  };
}

/** 章程里的人话字段名（`--detail` 展示章程时不重复列出）。 */
export const HUMAN_KEYS = new Set([
  ...Object.keys(OVERVIEW_TEXT),
  ...Object.keys(OVERVIEW_LISTS),
]);
export const OVERVIEW_KEYS = new Set([...HUMAN_KEYS, "stages"]);
