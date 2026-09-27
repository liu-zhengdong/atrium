import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { all, nodes, one } from "../org/model.ts";
import { hasOrg } from "../org/task-node.ts";
import { objectOf, onlyKeys } from "../tasks/ledger-validate.ts";
import {
  criteriaOf,
  goalRef,
  parseGoalRef,
  requireGoal,
  usage,
  type GoalRow,
} from "./model.ts";
import { GOALS_MAX } from "./rules.ts";
import {
  canJudge,
  itemStates,
  manualBlocker,
  type CheckRecord,
  type CheckResult,
} from "./check-rules.ts";

/** 达成判定的账（#313 第 2 步）：goal_checks 每次判定一行，只增不删；读时按条目原文取最新。 */

export type CheckRow = CheckRecord & {
  goal_id: number;
  log: string | null;
  owner: number | null;
};

const NOTE_MAX = 500;
/** 读最新判定时的上限：每个目标最多 20 条验收标准。 */
const LATEST_MAX = GOALS_MAX * 20;

/** 各目标每条验收标准原文的最新一次判定。 */
export function latestChecks(
  db: DatabaseSync,
  goalId?: number,
): Map<number, CheckRow[]> {
  const rows =
    goalId === undefined
      ? all<CheckRow>(
          db,
          "SELECT * FROM goal_checks WHERE id IN (SELECT MAX(id) FROM goal_checks GROUP BY goal_id,criterion) ORDER BY id LIMIT ?",
          LATEST_MAX,
        )
      : all<CheckRow>(
          db,
          "SELECT * FROM goal_checks WHERE id IN (SELECT MAX(id) FROM goal_checks WHERE goal_id=? GROUP BY criterion) ORDER BY id LIMIT 200",
          goalId,
        );
  const byGoal = new Map<number, CheckRow[]>();
  for (const row of rows)
    byGoal.set(row.goal_id, [...(byGoal.get(row.goal_id) ?? []), row]);
  return byGoal;
}

export function checkRow(db: DatabaseSync, id: number) {
  return one<CheckRow>(db, "SELECT * FROM goal_checks WHERE id=?", id);
}

/** 对外的判定记录：不带服务进程号与内部 goal_id。 */
export function checkView(row: CheckRow) {
  return {
    id: row.id,
    criterion: row.criterion,
    kind: row.kind,
    result: row.result,
    exit_code: row.exit_code,
    summary: row.summary,
    note: row.note,
    log: row.log,
    actor: row.actor,
    started_at: row.started_at,
    ended_at: row.ended_at,
  };
}
export type CheckView = ReturnType<typeof checkView>;

/** 条目与最新判定；验收标准记录损坏时按空列表。 */
export function goalItems(db: DatabaseSync, row: GoalRow) {
  return itemStates(
    criteriaOf(row).items,
    latestChecks(db, row.id).get(row.id) ?? [],
  );
}

export function insertCheck(
  db: DatabaseSync,
  input: {
    goal_id: number;
    criterion: string;
    kind: "command" | "manual";
    result: CheckResult;
    note?: string | null;
    owner?: number | null;
    actor: string;
    at: number;
  },
): number {
  const done = input.result !== "running";
  const { lastInsertRowid } = db
    .prepare(
      "INSERT INTO goal_checks(goal_id,criterion,kind,result,note,owner,actor,started_at,ended_at) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .run(
      input.goal_id,
      input.criterion,
      input.kind,
      input.result,
      input.note ?? null,
      input.owner ?? null,
      input.actor,
      input.at,
      done ? input.at : null,
    );
  return Number(lastInsertRowid);
}

/** 命令跑完写结论；只改仍在执行的行（服务重启时已判中断的不再覆盖）。 */
export function finishCheck(
  db: DatabaseSync,
  id: number,
  outcome: {
    result: Exclude<CheckResult, "running">;
    exit_code: number | null;
    summary: string;
    log: string | null;
  },
  at = Date.now(),
) {
  db.prepare(
    "UPDATE goal_checks SET result=?,exit_code=?,summary=?,log=?,ended_at=? WHERE id=? AND result='running'",
  ).run(
    outcome.result,
    outcome.exit_code,
    outcome.summary,
    outcome.log,
    at,
    id,
  );
}

/**
 * 启动自愈：执行中的判定若所属服务进程已不在（崩溃或被杀），判为没跑成。
 * 平滑重启时旧服务还活着，它的检查由它自己跑完落库。
 */
export function sweepInterrupted(
  db: DatabaseSync,
  alive: (pid: number) => boolean,
  self = process.pid,
  at = Date.now(),
) {
  const rows = all<{ id: number; owner: number | null }>(
    db,
    "SELECT id,owner FROM goal_checks WHERE result='running' ORDER BY id LIMIT 1000",
  );
  for (const row of rows)
    if (row.owner === null || (row.owner !== self && !alive(row.owner)))
      finishCheck(
        db,
        row.id,
        {
          result: "error",
          exit_code: null,
          summary: "服务中断，检查没跑完；重跑 atrium goal check",
          log: null,
        },
        at,
      );
}

/** 人工判定写不成命令的条目：`goal check gN --item N --pass|--fail --note 证据`。 */
export function judgeItem(
  db: DatabaseSync,
  reference: unknown,
  body: unknown,
  actor: string,
  now = Date.now(),
) {
  const id = parseGoalRef(reference, "目标");
  const input = objectOf(body);
  onlyKeys(input, ["item", "verdict", "note"]);
  if (input.verdict !== "pass" && input.verdict !== "fail")
    throw usage("--pass 或 --fail 二选一");
  const n = input.item;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1)
    throw usage("--item: 人工判定要指明第几条，如 --item 2");
  if (typeof input.note !== "string" || !input.note.trim())
    throw usage("--note: 人工判定要写证据（链接、命令输出或观察到的事实）");
  const note = input.note.trim();
  if (Array.from(note).length > NOTE_MAX)
    throw usage(`--note: 不能超过 ${NOTE_MAX} 字`);
  const row = requireGoal(db, id);
  if (row.status === "dropped")
    throw new Problem(409, `${goalRef(id)} 已放弃，不再判定`, "conflict");
  const allowed = canJudge(hasOrg(db) ? nodes(db) : [], row, actor);
  if (!allowed.ok) throw new Problem(403, allowed.reason, "conflict");
  const items = goalItems(db, row);
  const item = items[n - 1];
  if (!item)
    throw usage(
      `--item: ${goalRef(id)} 只有 ${items.length} 条验收标准`,
      `atrium goal show ${goalRef(id)}`,
    );
  const blocker = manualBlocker(item);
  if (blocker)
    throw usage(
      `--item: ${blocker}`,
      `atrium goal check ${goalRef(id)} --item ${n}`,
    );
  const checkId = insertCheck(db, {
    goal_id: id,
    criterion: item.text,
    kind: "manual",
    result: input.verdict,
    note,
    actor,
    at: now,
  });
  return checkView(checkRow(db, checkId)!);
}
