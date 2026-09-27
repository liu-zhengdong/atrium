/** 预算份额的解析和整棵树校验；这里不读数据库或 OpenQuota。 */
export type Share = {
  dim: "quota" | "disk" | "money";
  scope: string;
  amount: number;
};
export type ShareNode = {
  id: number;
  parent: number | null;
  name: string;
  shares: Share[];
};
export type ShareProblem = { field: string; message: string };
const provider = /^[a-z][a-z0-9-]{0,79}$/;

export function parseShares(value: unknown): {
  entries: Share[];
  problems: ShareProblem[];
} {
  const problems: ShareProblem[] = [];
  const entries: Share[] = [];
  const bad = (field: string, message: string) =>
    problems.push({ field, message });
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { entries, problems: [{ field: "budget", message: "应为对象" }] };
  const source = value as Record<string, unknown>;
  for (const [dim, raw] of Object.entries(source)) {
    if (dim === "quota") {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        bad("budget.quota", "应为账号到百分点的映射");
        continue;
      }
      for (const [scope, amount] of Object.entries(raw)) {
        const field = `budget.quota.${scope}`;
        if (scope !== "*" && !provider.test(scope)) bad(field, "账号名不合法");
        else if (
          typeof amount !== "number" ||
          !Number.isFinite(amount) ||
          amount < 0 ||
          amount > 100
        )
          bad(field, "应为 0 到 100 的数字");
        else entries.push({ dim: "quota", scope, amount });
      }
    } else if (dim === "disk" || dim === "money") {
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0)
        bad(`budget.${dim}`, "应为非负数字");
      else entries.push({ dim, scope: "", amount: raw });
    } else bad(`budget.${dim}`, "是未知字段");
  }
  if (entries.length > 40) bad("budget", "超过 40 个份额条目");
  return { entries, problems };
}

export function exportShares(
  entries: readonly Share[],
): Record<string, unknown> {
  const quota: Record<string, number> = {};
  const out: Record<string, unknown> = {};
  for (const entry of entries) {
    if (entry.dim === "quota") quota[entry.scope] = entry.amount;
    else out[entry.dim] = entry.amount;
  }
  if (Object.keys(quota).length) out.quota = quota;
  return out;
}

export function ownAmount(
  shares: readonly Share[],
  dim: Share["dim"],
  scope: string,
): number | undefined {
  return (
    shares.find((s) => s.dim === dim && s.scope === scope)?.amount ??
    (dim === "quota"
      ? shares.find((s) => s.dim === dim && s.scope === "*")?.amount
      : undefined)
  );
}

/** 未分配的共享池逐层扣除显式给兄弟的份额；磁盘根容量是动态值，写入时跳过。 */
export function shareCapacity(
  nodes: readonly ShareNode[],
  id: number,
  dim: Share["dim"],
  scope: string,
  rootLimit: { quota: number; money: number },
): number | undefined {
  const node = nodes.find((n) => n.id === id);
  if (!node) return undefined;
  if (node.parent === null) {
    const limit =
      dim === "quota"
        ? rootLimit.quota
        : dim === "money"
          ? rootLimit.money
          : undefined;
    const own = ownAmount(node.shares, dim, scope);
    return limit === undefined
      ? own
      : own === undefined
        ? limit
        : Math.min(limit, own);
  }
  const parent = nodes.find((n) => n.id === node.parent)!;
  const cap = shareCapacity(nodes, parent.id, dim, scope, rootLimit);
  const own = ownAmount(node.shares, dim, scope);
  if (own !== undefined) return own;
  if (cap === undefined) return undefined;
  const allocated = nodes
    .filter((n) => n.parent === parent.id)
    .reduce(
      (sum, sibling) => sum + (ownAmount(sibling.shares, dim, scope) ?? 0),
      0,
    );
  return Math.max(0, cap - allocated);
}

/** 同时检查父级和本级；全树最多 500 节点，账号来自已知账号及写入的 scope。 */
export function checkShares(
  nodes: readonly ShareNode[],
  rootLimit: { quota: number; money: number },
  knownProviders: readonly string[] = [],
): ShareProblem[] {
  const problems: ShareProblem[] = [];
  const scopes = new Set(["*", ...knownProviders]);
  for (const node of nodes)
    for (const share of node.shares)
      if (share.dim === "quota") scopes.add(share.scope);
  for (const parent of nodes) {
    const children = nodes.filter((n) => n.parent === parent.id);
    for (const dim of ["quota", "disk", "money"] as const) {
      for (const scope of dim === "quota" ? scopes : [""]) {
        const cap = shareCapacity(nodes, parent.id, dim, scope, rootLimit);
        if (cap === undefined) continue;
        const allocated = children
          .map((n) => ({ node: n, amount: ownAmount(n.shares, dim, scope) }))
          .filter(
            (e): e is { node: ShareNode; amount: number } =>
              e.amount !== undefined,
          );
        const sum = allocated.reduce((total, e) => total + e.amount, 0);
        if (sum > cap + 1e-9)
          problems.push({
            field: `budget.${dim}${dim === "quota" ? `.${scope}` : ""}`,
            message: `o${parent.id} ${parent.name} 可分配 ${cap}，子节点合计 ${sum}（${allocated.map((e) => `o${e.node.id} ${e.node.name} ${e.amount}`).join("、")}），超出 ${Number((sum - cap).toFixed(9))}`,
          });
      }
    }
    if (parent.parent === null) {
      for (const scope of scopes) {
        const amount = ownAmount(parent.shares, "quota", scope);
        if (amount !== undefined && amount > rootLimit.quota)
          problems.push({
            field: `budget.quota.${scope}`,
            message: `根节点最多可分配 ${rootLimit.quota}`,
          });
      }
      const money = ownAmount(parent.shares, "money", "");
      if (money !== undefined && money > rootLimit.money)
        problems.push({
          field: "budget.money",
          message: `根节点最多可分配 ${rootLimit.money} 元`,
        });
    }
  }
  return problems;
}
