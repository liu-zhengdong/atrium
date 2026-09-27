/**
 * 硬边界「下层只能收紧」：每个节点只存自己的条目，生效边界 = 根到本节点逐层叠加。
 * 本文件全是纯函数（无 IO），由 write.ts / read.ts 取数后调用。
 */

export const PARAM_KEYS = [
  "quota_reserve_percent",
  "disk_min_free_gb",
  "money_yuan_max",
] as const;
export type ParamKey = (typeof PARAM_KEYS)[number];
export type Param = { key: ParamKey; value: number };
/** 本节点自己的一条；覆盖条目的 summary 为空串，沿用上层。 */
export type Boundary = {
  id: string;
  summary: string;
  detail: string | null;
  param: Param | null;
};
export type Level = { node: number; name: string; entries: Boundary[] };
export type SubNode = Level & { parent: number };
export type EffectiveEntry = {
  id: string;
  summary: string;
  detail: string | null;
  param: Param | null;
  /** 条目最早出现的节点 */
  from: number;
  /** 参数当前最严值由哪个节点给出（无参数时同 from） */
  set_by: number;
};
export type BoundaryProblem = { field: string; message: string };
export type Converted = { node: number; id: string; summary: string };

export const MAX_SUMMARY = 80;
export const MAX_DETAIL = 500;
export const MAX_CHAIN_SUMMARY = 1200;
export const MAX_OWN = 40;
const ID = /^[a-z][a-z0-9-]{1,39}$/;
const RANGE: Record<ParamKey, [number, number]> = {
  quota_reserve_percent: [0, 100],
  disk_min_free_gb: [0, 100_000],
  money_yuan_max: [0, 1_000_000],
};
const UNIT: Record<ParamKey, string> = {
  quota_reserve_percent: "%",
  disk_min_free_gb: " GB",
  money_yuan_max: " 元",
};
const chars = (value: string) => Array.from(value).length;

/** quota/disk 越大越严，money 越小越严。 */
export function stricter(key: ParamKey, a: number, b: number): number {
  return key === "money_yuan_max" ? Math.min(a, b) : Math.max(a, b);
}
export function looser(key: ParamKey, candidate: number, floor: number) {
  return stricter(key, candidate, floor) !== candidate;
}
export function formatParam(param: Param): string {
  return `${param.key === "money_yuan_max" ? "至多" : "至少"} ${param.value}${UNIT[param.key]}`;
}

/** 按根→叶叠加；同 id 覆盖只取更严的参数，文字沿用最早出现的那条。 */
export function effective(levels: Level[]): EffectiveEntry[] {
  const out = new Map<string, EffectiveEntry>();
  for (const level of levels)
    for (const entry of level.entries) {
      const found = out.get(entry.id);
      if (!found) {
        out.set(entry.id, {
          id: entry.id,
          summary: entry.summary,
          detail: entry.detail,
          param: entry.param,
          from: level.node,
          set_by: level.node,
        });
        continue;
      }
      if (
        found.param &&
        entry.param &&
        entry.param.key === found.param.key &&
        stricter(found.param.key, found.param.value, entry.param.value) !==
          found.param.value
      ) {
        found.param = { ...found.param, value: entry.param.value };
        found.set_by = level.node;
      }
    }
  return [...out.values()];
}
export function summaryLength(list: EffectiveEntry[]): number {
  return list.reduce((sum, entry) => sum + chars(entry.summary), 0);
}

/** 把 frontmatter 里的 boundaries 解析成条目；结构错误逐条报，不抛。 */
export function parseBoundaries(value: unknown): {
  entries: Boundary[];
  problems: BoundaryProblem[];
} {
  const problems: BoundaryProblem[] = [];
  const entries: Boundary[] = [];
  if (!Array.isArray(value))
    return {
      entries,
      problems: [{ field: "boundaries", message: "应为条目列表" }],
    };
  if (value.length > MAX_OWN)
    problems.push({
      field: "boundaries",
      message: `本节点最多 ${MAX_OWN} 条`,
    });
  value.slice(0, MAX_OWN).forEach((raw, i) => {
    const field = `boundaries[${i}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      problems.push({ field, message: "应为对象" });
      return;
    }
    const item = raw as Record<string, unknown>;
    for (const key of Object.keys(item))
      if (!["id", "summary", "detail", "param"].includes(key))
        problems.push({ field: `${field}.${key}`, message: "是未知字段" });
    const id = typeof item.id === "string" ? item.id : "";
    const named = id ? `boundaries.${id}` : field;
    if (typeof item.id !== "string")
      problems.push({ field: `${field}.id`, message: "应为文本" });
    const summary = item.summary ?? "";
    if (typeof summary !== "string")
      problems.push({ field: `${named}.summary`, message: "应为文本" });
    const detail = item.detail ?? null;
    if (detail !== null && typeof detail !== "string")
      problems.push({ field: `${named}.detail`, message: "应为文本" });
    let param: Param | null = null;
    if (item.param !== undefined && item.param !== null) {
      const p = item.param;
      const keys =
        p && typeof p === "object" && !Array.isArray(p)
          ? Object.keys(p as object)
          : [];
      const key = keys[0] as ParamKey | undefined;
      const v = key ? (p as Record<string, unknown>)[key] : undefined;
      if (keys.length !== 1 || !PARAM_KEYS.includes(key!))
        problems.push({
          field: `${named}.param`,
          message: `应为 ${PARAM_KEYS.join("、")} 之一，且只写一个`,
        });
      else if (
        typeof v !== "number" ||
        !Number.isFinite(v) ||
        v < RANGE[key!][0] ||
        v > RANGE[key!][1]
      )
        problems.push({
          field: `${named}.param.${key}`,
          message: `应为 ${RANGE[key!][0]}–${RANGE[key!][1]} 的数`,
        });
      else param = { key: key!, value: v };
    }
    entries.push({
      id,
      summary: typeof summary === "string" ? summary.trim() : "",
      detail: typeof detail === "string" ? detail.trim() || null : null,
      param,
    });
  });
  return { entries, problems };
}

/** 导出为 frontmatter 用的普通对象；覆盖条目不写 summary。 */
export function exportBoundaries(entries: Boundary[]) {
  return entries.map((e) => ({
    id: e.id,
    ...(e.summary ? { summary: e.summary } : {}),
    ...(e.detail ? { detail: e.detail } : {}),
    ...(e.param ? { param: { [e.param.key]: e.param.value } } : {}),
  }));
}

export type CheckInput = {
  /** 本节点（修改后）上方的各层，根在前；移动节点时是新位置的祖先 */
  chain: Level[];
  /** 移动节点时原位置的祖先；缺省与 chain 相同 */
  oldChain?: Level[];
  node: { node: number; name: string };
  current: Boundary[];
  proposed: Boundary[];
  /** 后代，父在子前 */
  subtree: SubNode[];
  /** 节点显示名，用于报错 */
  label?: (node: number) => string;
};

/**
 * B1–B6 写入校验。返回问题列表（空 = 通过），以及 B6 中因上层删除而转为自有条目的后代条目。
 * 上层收紧时不查后代参数：生效值取整条链最严。
 */
export function checkBoundaries(input: CheckInput): {
  problems: BoundaryProblem[];
  converted: Converted[];
} {
  const problems: BoundaryProblem[] = [];
  const label = input.label ?? ((node: number) => `o${node}`);
  const moving = input.oldChain !== undefined;
  const oldChain = input.oldChain ?? input.chain;
  const inherited = effective(input.chain);
  const oldById = new Map(effective(oldChain).map((e) => [e.id, e]));
  const oldInherited = new Set(oldById.keys());
  const converted: Converted[] = [];
  const byId = new Map(inherited.map((e) => [e.id, e]));

  // B1：id 格式、唯一；文字长度
  const seen = new Set<string>();
  for (const entry of input.proposed) {
    const field = `boundaries.${entry.id || "（空 id）"}`;
    if (!ID.test(entry.id))
      problems.push({
        field,
        message: "id 只能用小写字母开头的小写英数与连字符，2–40 字",
      });
    else if (seen.has(entry.id))
      problems.push({ field, message: "id 在本节点重复" });
    seen.add(entry.id);
    if (chars(entry.summary) > MAX_SUMMARY)
      problems.push({
        field: `${field}.summary`,
        message: `超过 ${MAX_SUMMARY} 字`,
      });
    if (entry.detail && chars(entry.detail) > MAX_DETAIL)
      problems.push({
        field: `${field}.detail`,
        message: `超过 ${MAX_DETAIL} 字`,
      });
  }

  // B2 / B3：同 id 覆盖只许带参数，且只能收紧
  for (const entry of input.proposed) {
    const field = `boundaries.${entry.id}`;
    const above = byId.get(entry.id);
    if (!above) {
      const was = oldById.get(entry.id);
      if (!entry.summary && moving && was)
        converted.push({
          node: input.node.node,
          id: entry.id,
          summary: was.summary,
        });
      else if (!entry.summary)
        problems.push({ field: `${field}.summary`, message: "不能为空" });
      continue;
    }
    if (moving && !oldInherited.has(entry.id)) {
      problems.push({
        field,
        message: `移动后与上层 ${label(above.from)} 的同名条目冲突，请先改名`,
      });
      continue;
    }
    if (!above.param || !entry.param || above.param.key !== entry.param.key) {
      problems.push({
        field,
        message: above.param
          ? `覆盖上层 ${label(above.from)} 的条目只能改参数 ${above.param.key}`
          : `上层 ${label(above.from)} 的文字条目不能同 id 重写，要收紧就另加新条目`,
      });
      continue;
    }
    if (entry.summary && entry.summary !== above.summary)
      problems.push({
        field: `${field}.summary`,
        message: `覆盖条目只改参数，文字沿用上层 ${label(above.from)}，不要另写`,
      });
    // 未改动的旧条目不再查：上层后来收紧时生效值已取最严，不因此卡住本节点其他修改
    const old = input.current.find((e) => e.id === entry.id);
    const changed = old?.param?.value !== entry.param.value;
    if (
      changed &&
      looser(above.param.key, entry.param.value, above.param.value)
    )
      problems.push({
        field,
        message: `只能收紧，上层 ${label(above.set_by)} 要求${formatParam(above.param)}，这里写的是 ${entry.param.value}${UNIT[above.param.key]}`,
      });
  }

  // 本节点生效边界长度（B5）
  const self: Level = {
    ...input.node,
    entries: input.proposed.map((e) => {
      const filled = converted.find((c) => c.id === e.id);
      return filled ? { ...e, summary: filled.summary } : e;
    }),
  };
  const selfTotal = summaryLength(effective([...input.chain, self]));
  if (selfTotal > MAX_CHAIN_SUMMARY)
    problems.push({
      field: "boundaries",
      message: `整条链的 summary 合计 ${selfTotal} 字，超过 ${MAX_CHAIN_SUMMARY}`,
    });

  // 后代：B4 新上层条目不得与后代原有自有条目同名；B2 覆盖类型；B5 长度；B6 转换
  const oldSelf: Level = { ...input.node, entries: input.current };
  const oldLevels = new Map<number, Level[]>([
    [input.node.node, [...oldChain, oldSelf]],
  ]);
  const newLevels = new Map<number, Level[]>([
    [input.node.node, [...input.chain, self]],
  ]);
  for (const sub of input.subtree) {
    const oldAbove = oldLevels.get(sub.parent);
    const newAbove = newLevels.get(sub.parent);
    if (!oldAbove || !newAbove) continue;
    const before = effective(oldAbove);
    const beforeIds = new Set(before.map((e) => e.id));
    const after = new Map(effective(newAbove).map((e) => [e.id, e]));
    const beforeSummary = new Map(before.map((e) => [e.id, e.summary]));
    const entries: Boundary[] = [];
    for (const entry of sub.entries) {
      const field = `boundaries.${entry.id}`;
      const above = after.get(entry.id);
      let next = entry;
      if (above && !beforeIds.has(entry.id))
        problems.push({
          field,
          message: `后代 ${label(sub.node)} 已有同名条目，换一个 id`,
        });
      else if (
        above &&
        (!above.param || !entry.param || above.param.key !== entry.param.key)
      )
        problems.push({
          field,
          message: `后代 ${label(sub.node)} 以参数覆盖此条，这里不能改成${above.param ? `参数 ${above.param.key}` : "文字条目"}`,
        });
      else if (!above && beforeIds.has(entry.id)) {
        const summary =
          entry.summary || beforeSummary.get(entry.id) || entry.id;
        converted.push({ node: sub.node, id: entry.id, summary });
        next = { ...entry, summary };
      }
      entries.push(next);
    }
    const subLevel: Level = { ...sub, entries };
    oldLevels.set(sub.node, [...oldAbove, sub]);
    newLevels.set(sub.node, [...newAbove, subLevel]);
    const total = summaryLength(effective([...newAbove, subLevel]));
    if (total > MAX_CHAIN_SUMMARY)
      problems.push({
        field: "boundaries",
        message: `后代 ${label(sub.node)} 的整条链 summary 合计将为 ${total} 字，超过 ${MAX_CHAIN_SUMMARY}`,
      });
  }
  return { problems, converted };
}
