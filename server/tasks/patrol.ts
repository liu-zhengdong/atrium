import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { nodeByAddress, nodes, one as orgOne, ref } from "../org/model.ts";
import { overviewOf } from "../org/overview.ts";
import { taskRoute } from "../leaders/subscriber.ts";
import { getTask, createTask, atomically, parseTaskRef } from "./ledger.ts";
import type { EventInbox } from "./events.ts";

/** 巡检自己的账，独立于旧运行时表；按节点和现象去重。 */
export function ensurePatrolTables(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS patrol_runs (
    task_id INTEGER PRIMARY KEY REFERENCES tasks(id), node_id INTEGER NOT NULL,
    scenario TEXT NOT NULL, flow TEXT NOT NULL, created_at INTEGER NOT NULL,
    finished_at INTEGER);
    CREATE INDEX IF NOT EXISTS patrol_runs_node ON patrol_runs(node_id,task_id);
    CREATE TABLE IF NOT EXISTS patrol_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, node_id INTEGER NOT NULL,
      task_id INTEGER NOT NULL REFERENCES tasks(id), fingerprint TEXT NOT NULL,
      phenomenon TEXT NOT NULL, step TEXT NOT NULL, command TEXT NOT NULL,
      expected TEXT NOT NULL, actual TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('broken','awkward')),
      status TEXT NOT NULL CHECK(status IN ('new','task','merged','ignored')),
      linked_task_id INTEGER, reason TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(node_id,fingerprint));
    CREATE INDEX IF NOT EXISTS patrol_findings_node ON patrol_findings(node_id,id);`);
}

export type PatrolRun = {
  task_id: number;
  node_id: number;
  scenario: string;
  flow: string;
  created_at: number;
  finished_at: number | null;
};
export type Finding = {
  id: number;
  node_id: number;
  task_id: number;
  fingerprint: string;
  phenomenon: string;
  step: string;
  command: string;
  expected: string;
  actual: string;
  kind: "broken" | "awkward";
  status: "new" | "task" | "merged" | "ignored";
  linked_task_id: number | null;
  reason: string | null;
  created_at: number;
  updated_at: number;
};
export const findingView = ({
  fingerprint: _fingerprint,
  ...row
}: Finding) => ({
  ...row,
  ref: `f${row.id}`,
  node: ref(row.node_id),
  patrol: `t${row.task_id}`,
  linked_task: row.linked_task_id ? `t${row.linked_task_id}` : null,
});

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

const needed = (body: Record<string, unknown>, key: string, max: number) => {
  const value = body[key];
  if (typeof value !== "string" || !value.trim() || [...value].length > max)
    throw new Problem(400, `${key}: 应为 1～${max} 字`, "usage");
  return value.trim();
};
export function fingerprintOf(phenomenon: string) {
  return createHash("sha256")
    .update(
      phenomenon.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase(),
    )
    .digest("hex");
}

/** 发现记在当前节点，关联任务可以记在它下属部分。 */
export function inNodeTree(
  nodeId: number | null,
  rootId: number,
  parents: ReadonlyMap<number, number | null>,
) {
  const seen = new Set<number>();
  let current = nodeId;
  while (current !== null && !seen.has(current)) {
    if (current === rootId) return true;
    seen.add(current);
    current = parents.get(current) ?? null;
  }
  return false;
}

export function reportFinding(db: DatabaseSync, taskRef: string, raw: unknown) {
  const task = getTask(db, taskRef);
  const run = patrolRun(db, task.id);
  if (!run) throw new Problem(409, `${task.ref} 不是巡检任务`, "conflict");
  if (task.status !== "running")
    throw new Problem(409, `${task.ref} 没有在巡检`, "conflict");
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Problem(400, "发现字段应为对象", "usage");
  const body = raw as Record<string, unknown>;
  if (
    Object.keys(body).some(
      (key) =>
        ![
          "phenomenon",
          "step",
          "command",
          "expected",
          "actual",
          "kind",
        ].includes(key),
    )
  )
    throw new Problem(400, "发现含不支持的字段", "usage");
  const phenomenon = needed(body, "phenomenon", 200);
  const step = needed(body, "step", 200);
  const command = needed(body, "command", 500);
  const expected = needed(body, "expected", 1000);
  const actual = needed(body, "actual", 1000);
  if (body.kind !== "broken" && body.kind !== "awkward")
    throw new Problem(400, "kind: 只能是 broken 或 awkward", "usage");
  const fingerprint = fingerprintOf(phenomenon);
  const now = Date.now();
  const inserted = db
    .prepare(
      "INSERT OR IGNORE INTO patrol_findings(node_id,task_id,fingerprint,phenomenon,step,command,expected,actual,kind,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'new',?,?)",
    )
    .run(
      run.node_id,
      task.id,
      fingerprint,
      phenomenon,
      step,
      command,
      expected,
      actual,
      body.kind,
      now,
      now,
    );
  const row = db
    .prepare("SELECT * FROM patrol_findings WHERE node_id=? AND fingerprint=?")
    .get(run.node_id, fingerprint) as Finding;
  return { finding: findingView(row), duplicate: inserted.changes === 0 };
}

export function findingsForNode(db: DatabaseSync, nodeId: number) {
  return (
    db
      .prepare(
        "SELECT * FROM patrol_findings WHERE node_id=? ORDER BY id DESC LIMIT 100",
      )
      .all(nodeId) as Finding[]
  ).map(findingView);
}

export function findingNode(
  db: DatabaseSync,
  reference: string,
): number | null {
  const match = /^f([1-9]\d*)$/.exec(reference);
  if (!match) return null;
  return (
    (
      db
        .prepare("SELECT node_id FROM patrol_findings WHERE id=?")
        .get(Number(match[1])) as { node_id: number } | undefined
    )?.node_id ?? null
  );
}

/** 同一轮只收尾一次；有新发现唤醒 leader，零发现也留下知会事件。 */
export function finishPatrol(
  db: DatabaseSync,
  inbox: EventInbox,
  taskId: number,
) {
  const run = patrolRun(db, taskId);
  if (!run || run.finished_at !== null) return;
  db.prepare(
    "UPDATE patrol_runs SET finished_at=? WHERE task_id=? AND finished_at IS NULL",
  ).run(Date.now(), taskId);
  const findings = (
    db
      .prepare(
        "SELECT * FROM patrol_findings WHERE task_id=? ORDER BY id LIMIT 100",
      )
      .all(taskId) as Finding[]
  ).map(findingView);
  const route = taskRoute(db, getTask(db, taskId));
  inbox.publish({
    subscriber: route.subscriber,
    taskId,
    source: "patrol",
    kind: findings.length ? "patrol_findings" : "patrol_finished",
    key: `patrol:${taskId}`,
    detail: {
      node: ref(run.node_id),
      status: getTask(db, taskId).status,
      findings: findings.map((f) => ({
        ref: f.ref,
        phenomenon: f.phenomenon,
        kind: f.kind,
      })),
      routed: { to: route.subscriber, why: route.why },
    },
  });
}

export function decideFinding(
  db: DatabaseSync,
  reference: string,
  raw: unknown,
) {
  const match = /^f([1-9]\d*)$/.exec(reference);
  if (!match) throw new Problem(400, "发现短号应为 f1 这样的格式", "usage");
  const row = db
    .prepare("SELECT * FROM patrol_findings WHERE id=?")
    .get(Number(match[1])) as Finding | undefined;
  if (!row) throw new Problem(404, `发现 ${reference} 不存在`, "not_found");
  if (row.status !== "new")
    throw new Problem(409, `${reference} 已处理`, "conflict");
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Problem(400, "处理字段应为对象", "usage");
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some((k) => !["action", "task", "reason"].includes(k)))
    throw new Problem(400, "处理含不支持的字段", "usage");
  const action = body.action;
  if (action !== "task" && action !== "merged" && action !== "ignored")
    throw new Problem(400, "action: 只能是 task、merged 或 ignored", "usage");
  const reason =
    action === "ignored"
      ? needed(body, "reason", 1000)
      : typeof body.reason === "string"
        ? body.reason.trim().slice(0, 1000)
        : null;
  const linked = action === "ignored" ? null : parseTaskRef(body.task, "task");
  if (linked !== null) {
    const task = getTask(db, linked);
    const parents = new Map(nodes(db).map((n) => [n.id, n.parent_id]));
    if (!inNodeTree(task.part_id ?? task.node_id, row.node_id, parents))
      throw new Problem(
        409,
        `任务 ${task.ref} 不在发现所属节点及下层`,
        "conflict",
      );
  }
  db.prepare(
    "UPDATE patrol_findings SET status=?,linked_task_id=?,reason=?,updated_at=? WHERE id=?",
  ).run(action, linked, reason, Date.now(), row.id);
  return findingView(
    db
      .prepare("SELECT * FROM patrol_findings WHERE id=?")
      .get(row.id) as Finding,
  );
}
