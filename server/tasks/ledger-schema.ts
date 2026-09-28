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
import { ensureVerifyTables } from "./verify-runtime.ts";
import { ensureWorkerProfiles } from "./worker-profiles.ts";
import { ensureUrgentTables } from "./urgent-ledger.ts";
import { ensureSecretTables } from "../secrets/store.ts";
import { fixLikeTitle } from "./task-type.ts";

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

/** 没结束的任务按标题推断类型（t237）：像修 bug 的补成修复，其余保持功能；按 id 翻页，每页一次读、一条批量更新。 */
function backfillTypes(db: DatabaseSync) {
  const PAGE = 500;
  const read = db.prepare(
    "SELECT id,title FROM tasks WHERE status NOT IN ('done','cancelled') AND id>? ORDER BY id LIMIT ?",
  );
  for (let after = 0; ;) {
    const rows = read.all(after, PAGE) as { id: number; title: string }[];
    const fixes = rows.filter((row) => fixLikeTitle(row.title));
    if (fixes.length)
      db.prepare(
        `UPDATE tasks SET task_type='fix' WHERE id IN (${fixes.map(() => "?").join(",")})`,
      ).run(...fixes.map((row) => row.id));
    if (rows.length < PAGE) return;
    after = rows.at(-1)!.id;
  }
}

/** 老库里的帮手子任务：专员审查（每轮的审查任务）与会审意见，按登记表与运行时起的标题认。 */
function backfillHelpers(db: DatabaseSync) {
  db.exec(`UPDATE tasks SET helper=1 WHERE parent_id IS NOT NULL AND (
      title LIKE '专员审查：%' OR title LIKE '会审意见：%'
      OR id IN (SELECT review_id FROM task_concerns WHERE review_id IS NOT NULL)
      OR id IN (SELECT opinion_id FROM council_members))`);
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
    -- top 的取行（#t126）：按结束状态+时间走索引，不整表扫。
    CREATE INDEX IF NOT EXISTS tasks_status_updated ON tasks(status,updated_at,id);
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
  // 远程执行者（#358）：这一轮跑在哪台主机上，指向 hosts.id；本机为 NULL。
  if (!columns.some((column) => column.name === "host_id"))
    db.exec("ALTER TABLE tasks ADD COLUMN host_id INTEGER");
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
  // 任务大小（t276）：没写为 NULL，挑人时按详述与牵涉范围粗估。
  if (!columns.some((column) => column.name === "size"))
    db.exec(
      "ALTER TABLE tasks ADD COLUMN size TEXT CHECK(size IS NULL OR size IN ('small','medium','large'))",
    );
  // 任务类型（t237）：功能 / 修复；加列时把没结束的按标题补成修复。
  if (!columns.some((column) => column.name === "task_type")) {
    db.exec(
      "ALTER TABLE tasks ADD COLUMN task_type TEXT NOT NULL DEFAULT 'feature' CHECK(task_type IN ('feature','fix'))",
    );
    backfillTypes(db);
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
  // 旧任务回填查过即记下（t125）：别的仓库不再每分钟起 git。
  if (!columns.some((column) => column.name === "online_checked_at"))
    db.exec("ALTER TABLE tasks ADD COLUMN online_checked_at INTEGER");
  // CI 轮询公平（t125）：仍 pending 的记下本次查过，下一轮让后面的排上。
  if (!columns.some((column) => column.name === "ci_polled_at"))
    db.exec("ALTER TABLE tasks ADD COLUMN ci_polled_at INTEGER");
  db.exec(
    "CREATE INDEX IF NOT EXISTS tasks_delivery_stage ON tasks(delivery_stage,id)",
  );
  // 合入队、清理、上线回填、CI pending：部分索引，避免巡检误走 tasks_status 扫全部已完成。
  db.exec(
    "CREATE INDEX IF NOT EXISTS tasks_merge_queue ON tasks(delivery_stage,urgent,merge_queued_at,id) WHERE delivery_stage IN ('merge_queued','merging') AND status='done'",
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS tasks_cleanup_cancelled ON tasks(id)
     WHERE status='cancelled' AND worktree IS NOT NULL AND repo IS NOT NULL`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS tasks_cleanup_done ON tasks(id)
     WHERE status='done' AND delivery_stage IN ('merged','online')
       AND worktree IS NOT NULL AND repo IS NOT NULL`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS tasks_online_legacy ON tasks(id)
     WHERE delivery_stage='merged' AND online_wait=0 AND release_version IS NULL
       AND online_attempt IS NULL AND online_checked_at IS NULL`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS tasks_ci_pending ON tasks(ci_polled_at,id)
     WHERE ci='pending' AND pr_url IS NOT NULL AND status NOT IN ('done','cancelled')`,
  );
  // 未结束的任务（t154）：调度巡检与 plan 按 id 翻页只碰这些行，已完成的再多也不扫；
  // 带上 auto、schedule_state，巡检的候选过滤在索引里做完，不为不相干的行回表读大字段。
  db.exec(
    "CREATE INDEX IF NOT EXISTS tasks_open ON tasks(id,auto,schedule_state) WHERE status NOT IN ('done','cancelled')",
  );
  // top 里「已合入、等上线」的一支（#t126）：直接定位 online_wait=1，不扫全部 merged。
  db.exec(
    "CREATE INDEX IF NOT EXISTS tasks_online_wait ON tasks(online_wait,delivery_stage,id) WHERE online_wait=1",
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
    PRIMARY KEY(task_id,repo,number));
    CREATE INDEX IF NOT EXISTS task_pr_dependencies_pr ON task_pr_dependencies(repo,number);`);
  // 外部 PR 也记下一次可查时刻与连败次数（t122）：查不到的退避，不再每分钟空转。
  const prColumns = all<{ name: string }>(
    db,
    "PRAGMA table_info(task_pr_dependencies)",
  );
  if (!prColumns.some((column) => column.name === "next_check_at"))
    db.exec(
      "ALTER TABLE task_pr_dependencies ADD COLUMN next_check_at INTEGER",
    );
  if (!prColumns.some((column) => column.name === "attempts"))
    db.exec(
      "ALTER TABLE task_pr_dependencies ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0",
    );
  // 旧库补下一次可查时刻：沿用上次查询的一分钟节奏，避免升级瞬间全体重查。
  db.exec(
    "UPDATE task_pr_dependencies SET next_check_at=COALESCE(checked_at,0)+60000 WHERE next_check_at IS NULL AND merged=0",
  );
  ensureUpstreamPrTable(db);
  repairScheduleRecords(db);
  ensureUsageTable(db);
  // 全景图第 2 步（#322）：任务请了哪些专员、本轮审查任务与结论。
  ensureConcernTable(db);
  ensureAlsoTable(db);
  // 任务声明要用的凭据（t194）：task_secrets 随账本建，node_secrets 一起建好，建任务时要查。
  ensureSecretTables(db);
  // 全景图第 3 步（#322）：会审的议题、受邀专员与结论。
  ensureCouncilTables(db);
  // 总任务（t190）：有子任务的任务不再派、状态按子孙汇总；运行时替父任务建的帮手（专员审查、会审意见）不算子任务。
  if (!columns.some((column) => column.name === "helper")) {
    db.exec(
      "ALTER TABLE tasks ADD COLUMN helper INTEGER NOT NULL DEFAULT 0 CHECK(helper IN (0,1))",
    );
    backfillHelpers(db);
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS tasks_plan_children ON tasks(parent_id,id) WHERE helper=0",
  );
  ensureDeliveryRecords(db);
  ensurePatrolTables(db);
  // 上线后的端到端验证（t181）：验证任务与结论。
  ensureVerifyTables(db);
  // 执行者档案（#355）：三层档案与修订历史。
  ensureWorkerProfiles(db);
  // 紧急通道（t215）：原因、避开的主机、止损动作，被抢占的任务与合入后并行的审阅。
  ensureUrgentTables(db);
}
