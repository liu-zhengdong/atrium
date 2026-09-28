import type { DatabaseSync } from "node:sqlite";
import { all, nodePath, nodes, one, ref, type NodeRow } from "../org/model.ts";
import { hasOrg } from "../org/task-node.ts";
import {
  avoidReason,
  effectiveSkills,
  type ChainNode,
  type Effective,
  type Files,
} from "./model.ts";
import type { SkillRow } from "./store.ts";

/**
 * 派活时一个任务该带哪些技能（#264 第 3b 步）：节点链上绑定的 ∪ 执行者档案指定的，去重、有上限。
 */

type TaskLike = { part_id: number | null; node_id: number | null };

const hasSkills = (db: DatabaseSync) =>
  !!one(
    db,
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='org_skills'",
  );

/** 任务所在节点链（根 → 归属部分；旧任务看 node_id）；没关联节点返回空。 */
export function taskChain(db: DatabaseSync, task: TaskLike): ChainNode[] {
  const id = task.part_id ?? task.node_id;
  if (id === null || !hasOrg(db)) return [];
  const list = nodes(db);
  const chain: ChainNode[] = [];
  let current: NodeRow | undefined = list.find((n) => n.id === id);
  while (current) {
    chain.unshift({
      id: current.id,
      ref: ref(current.id),
      path: nodePath(list, current),
    });
    const parent: number | null = current.parent_id;
    current = list.find((n) => n.id === parent);
  }
  return chain;
}

/** 档案 avoid_nodes 用：任务节点链；取不到（没有组织表、没关联）返回空。 */
export function taskAvoidChain(db: DatabaseSync, task: TaskLike) {
  try {
    return taskChain(db, task);
  } catch {
    return [];
  }
}

export { avoidReason };

export type TaskSkill = {
  id: number;
  slug: string;
  name: string;
  description: string;
  rev: number;
  files: Files;
  via: string;
};
export type TaskSkills = Omit<Effective, "picked"> & { skills: TaskSkill[] };

export function skillsForTask(
  db: DatabaseSync,
  task: TaskLike,
  profile: Record<string, unknown> = {},
): TaskSkills {
  if (!hasSkills(db)) return { skills: [], dropped: [], unknown: [] };
  const chain = taskChain(db, task);
  const bound = new Map<number, string[]>();
  if (chain.length)
    for (const row of all<{ node_id: number; slug: string }>(
      db,
      `SELECT b.node_id node_id, s.slug slug FROM org_skill_bindings b JOIN org_skills s ON s.id=b.skill_id
       WHERE s.archived_at IS NULL AND b.node_id IN (${chain.map(() => "?").join(",")})
       ORDER BY s.slug LIMIT 500`,
      ...chain.map((node) => node.id),
    ))
      bound.set(row.node_id, [...(bound.get(row.node_id) ?? []), row.slug]);
  const rows = all<SkillRow>(
    db,
    "SELECT * FROM org_skills WHERE archived_at IS NULL ORDER BY slug LIMIT 500",
  );
  const bySlug = new Map(rows.map((row) => [row.slug, row]));
  const effective = effectiveSkills({
    chain,
    bound,
    profile,
    known: new Set(bySlug.keys()),
  });
  return {
    skills: effective.picked.map(({ slug, via }) => {
      const row = bySlug.get(slug)!;
      return {
        id: row.id,
        slug,
        name: row.name,
        description: row.description,
        rev: row.rev,
        files: JSON.parse(row.files) as Files,
        via,
      };
    }),
    dropped: effective.dropped,
    unknown: effective.unknown,
  };
}
