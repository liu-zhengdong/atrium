import type { DatabaseSync } from "node:sqlite";
import { all } from "./ledger-model.ts";
import { ensureQueueTable } from "./queue.ts";
import { repairScheduleRecords } from "./schedule-recovery.ts";
import { ensureUpstreamPrTable } from "./schedule-upstream.ts";
import { ensureUsageTable } from "./usage.ts";
import { ensureConcernTable } from "./concerns.ts";
import { ensureAlsoTable } from "./also.ts";
import { ensureDeliveryRecords } from "./delivery-records.ts";
import { ensureJobRoles } from "./job-roles.ts";
import { ensureCouncilTables } from "./councils.ts";
import { ensurePatrolTables } from "./patrol.ts";
import { ensureWorkerProfiles } from "./worker-profiles.ts";

/** 在途任务归属管方面的部分（或在它下面）的补成闲时；旧库没有组织表或 aspect 列就不动。 */
function backfillIdle(db: DatabaseSync) {
  const aspect = all<{ name: string }>(db, "PRAGMA table_info(org_nodes)").some(
    (column) => column.name === "aspect",
  );
  if (!aspect) return;
  db.exec(`WITH RECURSIVE idle(id) AS (
      SELECT id FROM org_nodes WHERE aspect=1
      UNION SELECT n.id FROM org_nodes n JOIN idle ON n.parent_id=idle.id)
    UPDATE tasks SET priority='idle'
      WHERE status NOT IN ('done','cancelled') AND COALESCE(part_id,node_id) IN (SELECT id FROM idle)`);
}

export function ensureTaskTables(db: DatabaseSync) {
  // 排队表随账本建好：列表与排期要读排队原因，不能等任务运行时起来。
  ensureQueueTable(db);
  ensureJobRoles(db);
  db.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_id INTEGER REFERENCES tasks(id),
      title TEXT NOT NULL,
      brief_path TEXT,
      role TEXT,
      repo TEXT,
      deliver TEXT NOT NULL DEFAULT 'pr' CHECK(deliver IN ('pr','comment','none')),
      issue INTEGER,
      status TEXT NOT NULL CHECK(status IN ('todo','running','done','failed','blocked','cancelled')),
      worker TEXT,
      pid INTEGER, worktree TEXT, branch TEXT,
      pr_url TEXT, ci TEXT,
      result TEXT,
      created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_id,id);
    CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status,id);
    CREATE TABLE IF NOT EXISTS task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL,
      at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT);
    CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id,id);
    CREATE INDEX IF NOT EXISTS task_events_kind ON task_events(task_id,kind,id);`);
  // 负责人（事件订阅者）是后加的列：老库补上，缺省交给秘书。
  const columns = all<{ name: string }>(db, "PRAGMA table_info(tasks)");
  // 任务详述进库（#355）：brief 存内容，brief_path 只记来源；旧任务启动时按路径回填（server/imports/）。
  if (!columns.some((column) => column.name === "brief"))
    db.exec("ALTER TABLE tasks ADD COLUMN brief TEXT");
  if (!columns.some((column) => column.name === "job_id"))
    db.exec("ALTER TABLE tasks ADD COLUMN job_id INTEGER");
  if (!columns.some((column) => column.name === "worker_effort"))
    db.exec("ALTER TABLE tasks ADD COLUMN worker_effort TEXT");
  if (!columns.some((column) => column.name === "worker_risk"))
    db.exec("ALTER TABLE tasks ADD COLUMN worker_risk TEXT");
  if (!columns.some((column) => column.name === "owner"))
    db.exec("ALTER TABLE tasks ADD COLUMN owner TEXT");
  if (!columns.some((column) => column.name === "deliver"))
    db.exec(
      "ALTER TABLE tasks ADD COLUMN deliver TEXT NOT NULL DEFAULT 'pr' CHECK(deliver IN ('pr','comment','none'))",
    );
  if (!columns.some((column) => column.name === "issue"))
    db.exec("ALTER TABLE tasks ADD COLUMN issue INTEGER");
  if (!columns.some((column) => column.name === "auto"))
    db.exec(
      "ALTER TABLE tasks ADD COLUMN auto INTEGER NOT NULL DEFAULT 0 CHECK(auto IN (0,1))",
    );
  if (!columns.some((column) => column.name === "auto_dispatched"))
    db.exec(
      "ALTER TABLE tasks ADD COLUMN auto_dispatched INTEGER NOT NULL DEFAULT 0 CHECK(auto_dispatched IN (0,1))",
    );
  // 紧急（t113）：跳过本机负载与执行者上限，排队与本地检查插到最前；标题写「紧急：」不算。
  if (!columns.some((column) => column.name === "urgent"))
    db.exec(
      "ALTER TABLE tasks ADD COLUMN urgent INTEGER NOT NULL DEFAULT 0 CHECK(urgent IN (0,1))",
    );
  if (!columns.some((column) => column.name === "schedule_state"))
    db.exec("ALTER TABLE tasks ADD COLUMN schedule_state TEXT");
  if (!columns.some((column) => column.name === "schedule_reason"))
    db.exec("ALTER TABLE tasks ADD COLUMN schedule_reason TEXT");
  // 组织树第 3 步（#264）：谁来做（记在谁的账上）、谁投的；指向 org_nodes.id，旧任务留空，经 org link-roles 显式回填。
  if (!columns.some((column) => column.name === "node_id"))
    db.exec("ALTER TABLE tasks ADD COLUMN node_id INTEGER");
  if (!columns.some((column) => column.name === "origin_node_id"))
    db.exec("ALTER TABLE tasks ADD COLUMN origin_node_id INTEGER");
  // 目标树（#313）：任务挂在哪个里程碑上，指向 goals.id；表与校验在 server/goals/。
  if (!columns.some((column) => column.name === "goal_id"))
    db.exec("ALTER TABLE tasks ADD COLUMN goal_id INTEGER");
  db.exec("CREATE INDEX IF NOT EXISTS tasks_goal ON tasks(goal_id,status)");
  // 全景图（#322）：任务归属哪一部分，指向 org_nodes.id；旧 goal_id 由目标树迁移按目标的负责节点回填。
  if (!columns.some((column) => column.name === "part_id"))
    db.exec("ALTER TABLE tasks ADD COLUMN part_id INTEGER");
  // 闲时（t136）：管方面的部分开的任务缺省排在普通任务后面；加列时把在途的管方面任务补成闲时。
  if (!columns.some((column) => column.name === "priority")) {
    db.exec(
      "ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('normal','idle'))",
    );
    backfillIdle(db);
  }
  // PR 交付后的合入阶段单独记录；旧任务不自动合入。
  if (!columns.some((column) => column.name === "delivery_stage"))
    db.exec("ALTER TABLE tasks ADD COLUMN delivery_stage TEXT");
  if (!columns.some((column) => column.name === "merge_returns"))
    db.exec(
      "ALTER TABLE tasks ADD COLUMN merge_returns INTEGER NOT NULL DEFAULT 0",
    );
  if (!columns.some((column) => column.name === "merge_queued_at"))
    db.exec("ALTER TABLE tasks ADD COLUMN merge_queued_at INTEGER");
  // 审阅关卡（#325）：这一轮审阅派出的审阅任务；每次进审阅重置。
  if (!columns.some((column) => column.name === "review_task"))
    db.exec("ALTER TABLE tasks ADD COLUMN review_task INTEGER");
  // 自动上线（#325）：合入提交、含它的版本、是否在等上线、为哪个版本自升级过。
  if (!columns.some((column) => column.name === "merge_commit"))
    db.exec("ALTER TABLE tasks ADD COLUMN merge_commit TEXT");
  if (!columns.some((column) => column.name === "release_version"))
    db.exec("ALTER TABLE tasks ADD COLUMN release_version TEXT");
  if (!columns.some((column) => column.name === "online_wait"))
    db.exec(
      "ALTER TABLE tasks ADD COLUMN online_wait INTEGER NOT NULL DEFAULT 0",
    );
  if (!columns.some((column) => column.name === "online_attempt"))
    db.exec("ALTER TABLE tasks ADD COLUMN online_attempt TEXT");
  db.exec(
    "CREATE INDEX IF NOT EXISTS tasks_delivery_stage ON tasks(delivery_stage,id)",
  );
  db.exec("CREATE INDEX IF NOT EXISTS tasks_part ON tasks(part_id,status)");
  db.exec(
    "CREATE INDEX IF NOT EXISTS tasks_review_task ON tasks(review_task) WHERE review_task IS NOT NULL",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS tasks_node ON tasks(node_id,status); CREATE INDEX IF NOT EXISTS tasks_origin_node ON tasks(origin_node_id,status)",
  );
  db.exec(`CREATE TABLE IF NOT EXISTS task_dependencies (
    task_id INTEGER NOT NULL REFERENCES tasks(id), after_id INTEGER NOT NULL REFERENCES tasks(id),
    PRIMARY KEY(task_id,after_id));
    CREATE INDEX IF NOT EXISTS task_dependencies_after ON task_dependencies(after_id,task_id);
    CREATE TABLE IF NOT EXISTS task_pr_dependencies (
    task_id INTEGER NOT NULL REFERENCES tasks(id), repo TEXT NOT NULL, number INTEGER NOT NULL,
    merged INTEGER NOT NULL DEFAULT 0, checked_at INTEGER, error TEXT,
    PRIMARY KEY(task_id,repo,number));`);
  ensureUpstreamPrTable(db);
  repairScheduleRecords(db);
  ensureUsageTable(db);
  // 全景图第 2 步（#322）：任务请了哪些专员、本轮审查任务与结论。
  ensureConcernTable(db);
  ensureAlsoTable(db);
  // 全景图第 3 步（#322）：会审的议题、受邀专员与结论。
  ensureCouncilTables(db);
  ensureDeliveryRecords(db);
  ensurePatrolTables(db);
  // 执行者档案（#355）：三层档案与修订历史。
  ensureWorkerProfiles(db);
}
