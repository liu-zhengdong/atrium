import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { nodeByAddress, one as orgOne, ref } from "../org/model.ts";
import { overviewOf } from "../org/overview.ts";
import { createTask, atomically } from "./ledger.ts";

/**
 * 体验巡检（周期任务 kind=patrol）：按节点 uses 场景轮换，巡检进程连本机服务照场景用一遍；
 * 发现问题直接建修复任务（同一部分同标题没结束的修复任务会被拒，见 ledger-write.ts）。
 * patrol_runs 只记哪件任务是巡检、这轮的场景。
 */
export function ensurePatrolTables(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS patrol_runs (
    task_id INTEGER PRIMARY KEY REFERENCES tasks(id), node_id INTEGER NOT NULL,
    scenario TEXT NOT NULL, flow TEXT NOT NULL, created_at INTEGER NOT NULL,
    finished_at INTEGER);
    CREATE INDEX IF NOT EXISTS patrol_runs_node ON patrol_runs(node_id,task_id);`);
}

export type PatrolRun = {
  task_id: number;
  node_id: number;
  scenario: string;
  flow: string;
  created_at: number;
  finished_at: number | null;
};
/** 缺少剧本时明确停下，避免巡检凭想象试用。 */
export function scenarioAt(uses: readonly string[], previous: number): string {
  if (!uses.length)
    throw new Problem(
      409,
      "节点还没有 uses 场景；先用 atrium map edit 节点 --uses 场景 补上",
      "conflict",
    );
  return uses[previous % uses.length]!;
}

export function patrolRun(
  db: DatabaseSync,
  taskId: number,
): PatrolRun | undefined {
  return db.prepare("SELECT * FROM patrol_runs WHERE task_id=?").get(taskId) as
    PatrolRun | undefined;
}

export function startPatrol(db: DatabaseSync, address: string) {
  const node = nodeByAddress(db, address);
  if (node.archived_at !== null)
    throw new Problem(409, `${ref(node.id)} 已归档`, "conflict");
  const doc = orgOne<{ fields: string }>(
    db,
    "SELECT fields FROM org_docs WHERE node_id=? AND doc='charter'",
    node.id,
  );
  let fields: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(doc?.fields ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      fields = parsed as Record<string, unknown>;
  } catch {
    /* 坏字段按空剧本处理。 */
  }
  const overview = overviewOf(fields, []);
  return atomically(db, () => {
    const count = (
      db
        .prepare("SELECT count(*) n FROM patrol_runs WHERE node_id=?")
        .get(node.id) as { n: number }
    ).n;
    const scenario = scenarioAt(overview.uses, count);
    const task = createTask(db, {
      title: `体验巡检：${node.name} · ${scenario}`,
      part: ref(node.id),
      deliver: "none",
      // 巡检开的任务算修复（排在普通任务前面）。
      priority: "fix",
    });
    db.prepare(
      "INSERT INTO patrol_runs(task_id,node_id,scenario,flow,created_at) VALUES (?,?,?,?,?)",
    ).run(
      task.id,
      node.id,
      scenario,
      JSON.stringify(overview.flow),
      Date.now(),
    );
    return { task, scenario, flow: overview.flow };
  });
}
