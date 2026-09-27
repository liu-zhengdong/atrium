import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { all, nodePath, nodes, one, ref, transaction } from "../org/model.ts";
import { hasOrg } from "../org/task-node.ts";
import { charterFields, writeCharterFields } from "../org/write.ts";
import { STAGE_LABEL, type Stage } from "../org/overview.ts";
import { addEvent } from "../tasks/ledger-model.ts";
import { allGoals, criteriaOf, dependencies, goalRef } from "./model.ts";
import { hasTaskGoals } from "./read.ts";
import {
  planMigration,
  type MigrateCheck,
  type MigrationPlan,
} from "./migrate-rules.ts";

/**
 * 目标树迁为节点阶段记录（#322 第 1 步）。默认预览；apply 只有 u1，先把整库备份到
 * `<ATRIUM_DATA>/backups/`，再在一个事务里：给负责节点的章程追加阶段（留章程修订，可 org revert）、
 * 回填任务归属部分、记下 gN → 节点映射并标记目标树下线。goals 与 tasks.goal_id 不改不删。
 */

export type Retirement = { at: number; actor: string; backup: string | null };

export function goalsRetired(db: DatabaseSync): Retirement | undefined {
  if (
    !one(
      db,
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='goal_retirement'",
    )
  )
    return undefined;
  return one<Retirement>(
    db,
    "SELECT at,actor,backup FROM goal_retirement WHERE id=1",
  );
}

/** 下线后 goal 命令统一的回执：指向该目标迁去的节点，没给目标就指向组织树。 */
export function retiredProblem(db: DatabaseSync, goal?: string) {
  const id = goal && /^g([1-9][0-9]{0,15})$/.exec(goal.trim())?.[1];
  const mapped = id
    ? one<{ node_id: number; name: string }>(
        db,
        "SELECT m.node_id,n.name FROM goal_migrations m JOIN org_nodes n ON n.id=m.node_id WHERE m.goal_id=?",
        Number(id),
      )
    : undefined;
  const next = mapped
    ? `atrium org show ${ref(mapped.node_id)}`
    : "atrium org tree";
  return new Problem(
    410,
    `目标树已迁为组织节点的阶段记录，goal 命令已下线${mapped ? `；g${id} 在 ${ref(mapped.node_id)} ${mapped.name}` : ""}。看阶段：${next}；改阶段：atrium org edit 节点 --charter 文件；任务归属改用 --part 节点`,
    "conflict",
    undefined,
    next,
  );
}

function plan(db: DatabaseSync): MigrationPlan {
  const list = hasOrg(db) ? nodes(db) : [];
  const goals = allGoals(db);
  const checks = all<MigrateCheck>(
    db,
    "SELECT goal_id,criterion,kind,result,exit_code,note,actor,started_at FROM goal_checks WHERE id IN (SELECT MAX(id) FROM goal_checks GROUP BY goal_id,criterion) ORDER BY id LIMIT 40000",
  );
  return planMigration({
    goals: goals.map((g) => ({ ...g, criteria: criteriaOf(g).items })),
    dependencies: dependencies(db),
    checks,
    nodes: list.map((n) => {
      const stages = charterFields(db, n.id).stages;
      return {
        id: n.id,
        name: n.name,
        path: nodePath(list, n),
        stages: Array.isArray(stages)
          ? stages
              .map((s) => (s as { id?: unknown })?.id)
              .filter((s): s is string => typeof s === "string")
          : [],
      };
    }),
    tasks: hasTaskGoals(db)
      ? all<{ id: number; goal_id: number; part_id: number | null }>(
          db,
          "SELECT id,goal_id,part_id FROM tasks WHERE goal_id IS NOT NULL ORDER BY id LIMIT 5000",
        )
      : [],
  });
}

function view(db: DatabaseSync, found: MigrationPlan) {
  const name = (id: number) =>
    one<{ name: string }>(db, "SELECT name FROM org_nodes WHERE id=?", id)
      ?.name ?? "";
  const stage = (s: Stage) => ({
    id: s.id,
    result: s.result,
    status: s.status,
    status_label: STAGE_LABEL[s.status],
    criteria: s.criteria?.length ?? 0,
    evidence: s.evidence?.length ?? 0,
  });
  const task = (t: { task: number; goal: number; part: number }) => ({
    task: `t${t.task}`,
    goal: goalRef(t.goal),
    part: ref(t.part),
    part_name: name(t.part),
  });
  return {
    nodes: found.nodes.map((n) => ({
      node: ref(n.node),
      name: n.name,
      path: n.path,
      stages: n.stages.map(stage),
      kept: n.kept,
    })),
    tasks: found.tasks.map(task),
    tasks_kept: found.tasks_kept.map(task),
    orphans: found.orphans.map((o) => ({
      goal: goalRef(o.goal),
      node: ref(o.node),
    })),
    stages: found.nodes.reduce((sum, n) => sum + n.stages.length, 0),
  };
}

export function migrateGoals(
  db: DatabaseSync,
  options: { apply: boolean; actor: string; data: string; now?: number },
) {
  const retired = goalsRetired(db);
  const preview = plan(db);
  if (!options.apply)
    return { preview: true, retired: !!retired, ...view(db, preview) };
  if (options.actor !== "u1")
    throw new Problem(403, "org migrate-goals --apply 只有你能执行");
  if (preview.orphans.length)
    throw new Problem(
      409,
      `这些目标的负责节点不在组织树里，先改到现有节点再迁：${preview.orphans.map((o) => `${goalRef(o.goal)}（${ref(o.node)}）`).join("、")}`,
      "conflict",
      undefined,
      `atrium goal edit ${goalRef(preview.orphans[0]!.goal)} --node 节点`,
    );
  const pending =
    preview.tasks.length || preview.nodes.some((n) => n.stages.length);
  if (retired && !pending)
    return {
      preview: false,
      retired: true,
      backup: retired.backup,
      ...view(db, preview),
    };
  const now = options.now ?? Date.now();
  const stamp = new Date(now).toISOString().replace(/[-:]/g, "").slice(0, 15);
  const backup = join(
    options.data,
    "backups",
    `before-goal-migration-${stamp}.sqlite`,
  );
  mkdirSync(join(options.data, "backups"), { recursive: true, mode: 0o700 });
  db.prepare("VACUUM INTO ?").run(backup);
  return transaction(db, () => {
    const found = plan(db);
    for (const node of found.nodes) {
      if (!node.stages.length) continue;
      const fields = charterFields(db, node.node);
      const existing = Array.isArray(fields.stages) ? fields.stages : [];
      writeCharterFields(
        db,
        node.node,
        { ...fields, stages: [...existing, ...node.stages] },
        `目标树迁为阶段记录（#322）：${node.stages.map((s) => s.id).join("、")}`,
        options.actor,
      );
    }
    for (const task of found.tasks) {
      db.prepare(
        "UPDATE tasks SET part_id=?,updated_at=? WHERE id=? AND part_id IS NULL",
      ).run(task.part, now, task.task);
      addEvent(db, task.task, now, "edited", {
        part_id: task.part,
        from_goal: goalRef(task.goal),
      });
    }
    for (const goal of allGoals(db))
      db.prepare(
        "INSERT OR IGNORE INTO goal_migrations(goal_id,node_id,at) VALUES(?,?,?)",
      ).run(goal.id, goal.node_id, now);
    db.prepare(
      "INSERT OR IGNORE INTO goal_retirement(id,at,actor,backup) VALUES(1,?,?,?)",
    ).run(now, options.actor, backup);
    return { preview: false, retired: true, backup, ...view(db, found) };
  });
}
