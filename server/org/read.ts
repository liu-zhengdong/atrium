import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import {
  all,
  nodeByAddress,
  nodePath,
  nodes,
  one,
  ref,
  type Doc,
  type DocRow,
  type RevisionRow,
} from "./model.ts";
import { exportDocument } from "./validate.ts";
import { effective, exportBoundaries, summaryLength } from "./boundaries.ts";
import { allBoundaries, chainLevels } from "./boundary-store.ts";
import { goalChain, type GoalLevel } from "./goal-chain.ts";
import { HUMAN_KEYS, overviewOf } from "./overview.ts";
import { chainPoints, nodePoints } from "./points.ts";
import { nodeTasks, taskCounts, type TaskCounts } from "./task-link.ts";
import { allShares, rootLimits } from "./share-store.ts";
import { exportShares, shareCapacity, type ShareNode } from "./shares.ts";
import type { PaceEntry } from "../tasks/prepare.ts";
import { usageSample, subtreeUsage } from "../tasks/usage.ts";

function budgetViews(db: DatabaseSync, pace?: readonly PaceEntry[]) {
  const list = nodes(db);
  const owned = allShares(db);
  const tree: ShareNode[] = list.map((n) => ({
    id: n.id,
    parent: n.parent_id,
    name: n.name,
    shares: owned.get(n.id) ?? [],
  }));
  const limits = rootLimits(db, list);
  const scopes = new Set(["claude", "codex", "opencode", "kimi", "grok"]);
  const allocated = new Set<string>();
  for (const shares of owned.values())
    for (const s of shares)
      if (s.dim === "quota") {
        allocated.add(s.scope);
        if (s.scope !== "*") scopes.add(s.scope);
      }
  const subtree = (id: number) => {
    const ids = [id];
    for (let i = 0; i < ids.length; i++)
      for (const child of list.filter((n) => n.parent_id === ids[i]))
        ids.push(child.id);
    return ids;
  };
  const now = Date.now();
  return new Map(
    list.map((n) => [
      n.id,
      {
        own: exportShares(owned.get(n.id) ?? []),
        quota: [...scopes].sort().map((scope) => ({
          scope,
          amount: shareCapacity(tree, n.id, "quota", scope, limits),
          used:
            scope === "*"
              ? null
              : (() => {
                  const sample = usageSample(pace, scope, now);
                  return sample
                    ? Number(
                        subtreeUsage(
                          db,
                          subtree(n.id),
                          scope,
                          sample.reset,
                        ).toFixed(2),
                      )
                    : null;
                })(),
          relevant: allocated.has(scope) || allocated.has("*"),
          shared: !(owned.get(n.id) ?? []).some(
            (s) => s.dim === "quota" && (s.scope === scope || s.scope === "*"),
          ),
        })),
        disk: {
          amount: shareCapacity(tree, n.id, "disk", "", limits),
          shared: !(owned.get(n.id) ?? []).some((s) => s.dim === "disk"),
        },
        money: {
          amount: shareCapacity(tree, n.id, "money", "", limits),
          shared: !(owned.get(n.id) ?? []).some((s) => s.dim === "money"),
        },
      },
    ]),
  );
}

export function tree(db: DatabaseSync, pace?: readonly PaceEntry[]) {
  const list = nodes(db);
  if (list.length > 500) throw new Problem(409, "组织树超过 500 个节点");
  const order: typeof list = [];
  const visit = (parent: number | null) => {
    for (const n of list.filter((item) => item.parent_id === parent)) {
      order.push(n);
      visit(n.id);
    }
  };
  visit(null);
  // 名下任务按子树汇总（项目的「在做」含各模块）；投出的只算节点自己。
  const counts = taskCounts(db);
  const budgets = budgetViews(db, pace);
  const subtree = new Map<number, TaskCounts>();
  for (const n of [...order].reverse()) {
    const sum = {
      ...(counts.own.get(n.id) ?? { todo: 0, running: 0, blocked: 0 }),
    };
    for (const child of list.filter((item) => item.parent_id === n.id)) {
      const c = subtree.get(child.id)!;
      sum.todo += c.todo;
      sum.running += c.running;
      sum.blocked += c.blocked;
    }
    subtree.set(n.id, sum);
  }
  return order.map((original) => {
    const { doc_path: _legacyDocPath, ...n } = original;
    return {
      ...n,
      ref: ref(n.id),
      path: nodePath(list, original),
      repos: all<{ repo: string }>(
        db,
        "SELECT repo FROM org_node_repos WHERE node_id=? ORDER BY repo",
        n.id,
      ).map((r) => r.repo),
      tasks: subtree.get(n.id)!,
      sent: counts.sent.get(n.id) ?? { todo: 0, running: 0, blocked: 0 },
      budget: budgets.get(n.id),
    };
  });
}
export function show(
  db: DatabaseSync,
  address: string,
  raw?: Doc,
  pace?: readonly PaceEntry[],
) {
  const n = nodeByAddress(db, address),
    list = tree(db, pace);
  const node = list.find((item) => item.id === n.id)!;
  const charter = one<DocRow>(
    db,
    "SELECT * FROM org_docs WHERE node_id=? AND doc='charter'",
    n.id,
  );
  const card = one<DocRow>(
    db,
    "SELECT * FROM org_docs WHERE node_id=? AND doc='card'",
    n.id,
  );
  const view = (doc: DocRow | undefined) =>
    doc
      ? {
          rev: `r${doc.rev}`,
          fields: JSON.parse(doc.fields) as Record<string, unknown>,
          body: doc.body,
          updated_by: doc.updated_by,
          updated_at: doc.updated_at,
        }
      : null;
  const owned = allBoundaries(db);
  if (raw) {
    const found = raw === "charter" ? charter : card;
    return {
      raw: exportDocument(
        found ? (JSON.parse(found.fields) as Record<string, unknown>) : {},
        found?.body ?? "",
        raw === "charter" ? exportBoundaries(owned.get(n.id) ?? []) : undefined,
        raw === "charter"
          ? exportShares(allShares(db).get(n.id) ?? [])
          : undefined,
      ),
      ref: ref(n.id),
      doc: raw,
    };
  }
  const goalOf = (id: number) => {
    const doc = one<DocRow>(
      db,
      "SELECT * FROM org_docs WHERE node_id=? AND doc='charter'",
      id,
    );
    const goal = doc
      ? (JSON.parse(doc.fields) as { goal?: unknown }).goal
      : undefined;
    return typeof goal === "string" ? goal : "";
  };
  const levels: GoalLevel[] = [];
  let current: typeof node | undefined = node;
  while (current) {
    const id = current.id;
    levels.unshift({
      ref: current.ref,
      name: current.name,
      goal: goalOf(id),
      children: list.filter((item) => item.parent_id === id).map((c) => c.name),
    });
    current = list.find((item) => item.id === current?.parent_id);
  }
  const all = nodes(db);
  const name = (id: number) => all.find((item) => item.id === id)?.name ?? "";
  const upper = chainLevels(all, owned, n.parent_id);
  const inherited = new Set(effective(upper).map((e) => e.id));
  const own = owned.get(n.id) ?? [];
  const merged = effective([
    ...upper,
    { node: n.id, name: n.name, entries: own },
  ]);
  const boundaries = {
    chars: summaryLength(merged),
    inherited: merged.filter((e) => e.from !== n.id).length,
    added: merged.filter((e) => e.from === n.id).length,
    items: merged.map((e) => ({
      ...e,
      from: ref(e.from),
      from_name: name(e.from),
      set_by: ref(e.set_by),
      set_by_name: name(e.set_by),
    })),
    own: own.map((e) => {
      const live = merged.find((item) => item.id === e.id)!;
      const shadowed =
        e.param && live.param && live.set_by !== n.id
          ? live.param.value !== e.param.value
          : false;
      return {
        ...e,
        override: inherited.has(e.id),
        ...(shadowed
          ? {
              shadowed_by: ref(live.set_by),
              shadowed_by_name: name(live.set_by),
            }
          : {}),
      };
    }),
  };
  const fieldsOf = (id: number) => {
    const doc = one<DocRow>(
      db,
      "SELECT * FROM org_docs WHERE node_id=? AND doc='charter'",
      id,
    );
    try {
      return doc ? (JSON.parse(doc.fields) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  const overview = overviewOf(
    fieldsOf(n.id),
    list
      .filter((item) => item.parent_id === n.id)
      .map((child) => {
        const fields = fieldsOf(child.id);
        return {
          ref: child.ref,
          name: child.name,
          alias: typeof fields.alias === "string" ? fields.alias.trim() : "",
          analogy:
            typeof fields.analogy === "string" ? fields.analogy.trim() : "",
          archived: child.archived_at !== null,
          tasks: child.tasks,
        };
      }),
  );
  return {
    ...node,
    overview,
    points: nodePoints(db, n.id),
    // 根 → 本节点每层的要点；后续派活按它附「本节点及上级的要点」
    points_chain: chainPoints(db, n.id),
    recent_tasks: nodeTasks(db, n.id),
    boundaries,
    charter: view(charter),
    card: view(card),
    chain: goalChain(levels),
  };
}
/** A compact line diff for a single revision; both inputs are capped at 16 KB. */
function bodyDiff(before: string, after: string): string {
  const a = before.split("\n"),
    b = after.split("\n");
  let head = 0,
    tail = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  return [
    ...a.slice(head, a.length - tail).map((line) => `- ${line}`),
    ...b.slice(head, b.length - tail).map((line) => `+ ${line}`),
  ].join("\n");
}

export function history(
  db: DatabaseSync,
  address: string,
  options: {
    before?: string;
    after?: string;
    rev?: string;
    limit?: number;
    target?: string;
  },
) {
  const n = nodeByAddress(db, address);
  const parse = (value: string | undefined, field: string) => {
    if (value === undefined) return undefined;
    if (!/^r[1-9][0-9]*$/.test(value))
      throw new Problem(400, `${field} 应为 rN`);
    return Number(value.slice(1));
  };
  const before = parse(options.before, "--before"),
    after = parse(options.after, "--after"),
    wanted = parse(options.rev, "--rev");
  const target = options.target;
  if (target !== undefined && !["node", "charter", "card"].includes(target))
    throw new Problem(400, "--target 只能是 node、charter、card");
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Problem(400, "--limit 应为 1–100");
  if (wanted !== undefined) {
    const matches = all<RevisionRow>(
      db,
      "SELECT * FROM org_revisions WHERE node_id=? AND rev=? AND (? IS NULL OR target=?) ORDER BY id DESC LIMIT 4",
      n.id,
      wanted,
      target ?? null,
      target ?? null,
    );
    if (matches.length > 1)
      throw new Problem(
        409,
        `r${wanted} 在多个文档中存在，请加 --target ${matches.map((m) => m.target).join("|")}`,
      );
    const row = matches[0];
    if (!row) throw new Problem(404, `${ref(n.id)} r${wanted} 不存在`);
    const previous = one<RevisionRow>(
      db,
      "SELECT * FROM org_revisions WHERE node_id=? AND target=? AND rev=?",
      n.id,
      row.target,
      wanted - 1,
    );
    const current = JSON.parse(row.snapshot) as Record<string, unknown>,
      old = previous
        ? (JSON.parse(previous.snapshot) as Record<string, unknown>)
        : {};
    const beforeFields = (old.fields ?? {}) as Record<string, unknown>,
      afterFields = (current.fields ?? {}) as Record<string, unknown>;
    const changes: Record<
      string,
      { before: unknown; after: unknown; diff?: string }
    > = {};
    for (const key of new Set([
      ...Object.keys(beforeFields),
      ...Object.keys(afterFields),
    ]))
      if (
        (row.target !== "charter" || !HUMAN_KEYS.has(key)) &&
        JSON.stringify(beforeFields[key]) !== JSON.stringify(afterFields[key])
      )
        changes[`fields.${key}`] = {
          before: beforeFields[key] ?? null,
          after: afterFields[key] ?? null,
        };
    if (current.boundaries !== undefined || old.boundaries !== undefined) {
      type Item = { id: string };
      const list = (value: unknown) =>
        new Map(
          (Array.isArray(value) ? (value as Item[]) : []).map((item) => [
            item.id,
            item,
          ]),
        );
      const a = list(old.boundaries),
        b = list(current.boundaries);
      for (const id of new Set([...a.keys(), ...b.keys()]))
        if (JSON.stringify(a.get(id)) !== JSON.stringify(b.get(id)))
          changes[`boundaries.${id}`] = {
            before: a.get(id) ?? null,
            after: b.get(id) ?? null,
          };
    }
    if (current.budget !== undefined || old.budget !== undefined) {
      const flatten = (value: unknown) => {
        const data =
          value && typeof value === "object"
            ? (value as Record<string, unknown>)
            : {};
        const quota =
          data.quota && typeof data.quota === "object"
            ? (data.quota as Record<string, unknown>)
            : {};
        const flat: Record<string, unknown> = {
          ...Object.fromEntries(
            Object.entries(quota).map(([scope, amount]) => [
              `quota.${scope}`,
              amount,
            ]),
          ),
          ...(data.disk === undefined ? {} : { disk: data.disk }),
          ...(data.money === undefined ? {} : { money: data.money }),
        };
        return flat;
      };
      const before = flatten(old.budget),
        after = flatten(current.budget);
      for (const key of new Set([
        ...Object.keys(before),
        ...Object.keys(after),
      ]))
        if (before[key] !== after[key])
          changes[`budget.${key}`] = {
            before: before[key] ?? null,
            after: after[key] ?? null,
          };
    }
    for (const key of new Set([...Object.keys(old), ...Object.keys(current)])) {
      if (key === "fields" || key === "boundaries" || key === "budget")
        continue;
      if (JSON.stringify(old[key]) !== JSON.stringify(current[key]))
        changes[key] = {
          before: old[key] ?? null,
          after: current[key] ?? null,
          ...(key === "body"
            ? {
                diff: bodyDiff(
                  String(old[key] ?? ""),
                  String(current[key] ?? ""),
                ),
              }
            : {}),
        };
    }
    return { ref: ref(n.id), revision: { ...row, snapshot: current }, changes };
  }
  const rows = all<RevisionRow>(
    db,
    `SELECT * FROM org_revisions WHERE node_id=? AND (? IS NULL OR target=?) AND (? IS NULL OR rev<?) AND (? IS NULL OR rev>?) ORDER BY id DESC LIMIT ?`,
    n.id,
    target ?? null,
    target ?? null,
    before ?? null,
    before ?? null,
    after ?? null,
    after ?? null,
    limit + 1,
  );
  return {
    ref: ref(n.id),
    items: rows
      .slice(0, limit)
      .map((row) => ({ ...row, snapshot: JSON.parse(row.snapshot) })),
    has_more: rows.length > limit,
  };
}
