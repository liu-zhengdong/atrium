/**
 * 章程 budget 的旧写法（`~/Atrium/charter.md` 时代）：budget 下直接写 `quota_reserve_percent`、
 * `money`、`disk_min_free_gb`。现在前两项是硬边界的参数（boundaries 里带 param 的条目），budget 只放份额
 * （quota / disk / money）。写章程时认旧写法：出现旧键就把它们折成边界参数，写了的更新或补上；
 * 磁盘下限不再使用（u1 09-28 定），旧写法里写了也丢掉，已有的磁盘下限条目一并去掉。纯函数，不读库。
 */

/** 只要出现其中一个键，就按旧写法理解整个 budget（此时 money 指花费上限，不是份额）。 */
const MARKERS = ["quota_reserve_percent", "disk_min_free_gb", "money_yuan_max"];
const RETIRED = "disk_min_free_gb";

/** 旧键 → 边界参数；与根章程导入（imports/charter.ts）的条目 id、文字一致。 */
const LIFT: Record<string, { key: string; id: string; summary: string }> = {
  quota_reserve_percent: {
    key: "quota_reserve_percent",
    id: "quota-reserve",
    summary: "每个订阅账号的周期额度留给用户",
  },
  money: { key: "money_yuan_max", id: "money", summary: "花费上限（元）" },
  money_yuan_max: {
    key: "money_yuan_max",
    id: "money",
    summary: "花费上限（元）",
  },
};

type Raw = Record<string, unknown>;
const isObject = (value: unknown): value is Raw =>
  !!value && typeof value === "object" && !Array.isArray(value);
const paramKey = (entry: unknown) =>
  isObject(entry) && isObject(entry.param)
    ? Object.keys(entry.param)[0]
    : undefined;

export function isLegacyBudget(budget: unknown): budget is Raw {
  return isObject(budget) && MARKERS.some((key) => key in budget);
}

/**
 * 把旧写法的 budget 拆成新写法的 budget 与 boundaries。
 * boundaries 是本节点自有条目（frontmatter 写的，没写时由调用方给当前的）；inherited 是上层已有的条目 id，
 * 撞上时只写参数覆盖（文字沿用上层）。boundaries 不是列表时原样返回，交给边界校验报错。
 */
export function liftLegacyBudget(
  budget: Raw,
  boundaries: unknown,
  inherited: ReadonlySet<string> = new Set(),
): { budget: Raw; boundaries: unknown } {
  const rest: Raw = {};
  const values = new Map<string, unknown>();
  for (const [name, value] of Object.entries(budget)) {
    if (name === RETIRED) continue;
    const lift = LIFT[name];
    if (lift) values.set(lift.key, value);
    else rest[name] = value;
  }
  if (!Array.isArray(boundaries)) return { budget: rest, boundaries };
  const out: unknown[] = [];
  for (const entry of boundaries) {
    const key = paramKey(entry);
    if (key === RETIRED) continue;
    if (key && values.has(key)) {
      out.push({ ...(entry as Raw), param: { [key]: values.get(key) } });
      values.delete(key);
    } else out.push(entry);
  }
  for (const [key, value] of values) {
    const lift = Object.values(LIFT).find((l) => l.key === key)!;
    out.push(
      inherited.has(lift.id)
        ? { id: lift.id, param: { [key]: value } }
        : { id: lift.id, summary: lift.summary, param: { [key]: value } },
    );
  }
  return { budget: rest, boundaries: out };
}
