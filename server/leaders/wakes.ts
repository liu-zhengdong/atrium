import type { DatabaseSync } from "node:sqlite";
import { all, one } from "../org/model.ts";
import { busyLine, type Lane } from "./clones.ts";

/**
 * 唤醒记账（runtime 调用）：`leader_clones` 记在跑的分身（一个分身一行，结束即删），
 * `org_leaders.wake_*` 记整体的最近一次唤醒——有分身在跑就是 running，摘要是各分身合起来的一句
 * （「2 件：t197 规划待采纳；t84 上线」），都结束后是最后结束那个的结局。旧运行时没有同名表。
 */

export function ensureWakeTables(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS leader_clones (
    leader TEXT NOT NULL, slot INTEGER NOT NULL,
    lane TEXT NOT NULL, label TEXT NOT NULL,
    groups_json TEXT NOT NULL, summary TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    PRIMARY KEY(leader, slot))`);
}

export type CloneView = {
  slot: number;
  lane: Lane;
  label: string;
  groups: string[];
  summary: string;
  since: number;
};

type CloneRow = {
  leader: string;
  slot: number;
  lane: Lane;
  label: string;
  groups_json: string;
  summary: string;
  started_at: number;
};

const cloneOf = (row: CloneRow): CloneView => {
  let groups: string[] = [];
  try {
    const parsed = JSON.parse(row.groups_json) as unknown;
    if (Array.isArray(parsed))
      groups = parsed.filter((g): g is string => typeof g === "string");
  } catch {
    groups = [];
  }
  return {
    slot: row.slot,
    lane: row.lane === "big" ? "big" : "routine",
    label: row.label,
    groups,
    summary: row.summary,
    since: row.started_at,
  };
};

const idOf = (leader: string) => Number(leader.slice(1));

const hasClones = (db: DatabaseSync) =>
  !!one(
    db,
    "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='leader_clones'",
  );

/** 每位 leader 在跑的分身，按分身号。 */
export function runningClones(db: DatabaseSync): Map<string, CloneView[]> {
  const map = new Map<string, CloneView[]>();
  if (!hasClones(db)) return map;
  for (const row of all<CloneRow>(
    db,
    "SELECT * FROM leader_clones ORDER BY leader,slot LIMIT 500",
  ))
    map.set(row.leader, [...(map.get(row.leader) ?? []), cloneOf(row)]);
  return map;
}

export function clonesOf(db: DatabaseSync, leader: string): CloneView[] {
  if (!hasClones(db)) return [];
  return all<CloneRow>(
    db,
    "SELECT * FROM leader_clones WHERE leader=? ORDER BY slot LIMIT 50",
    leader,
  ).map(cloneOf);
}

const summaryOf = (clones: readonly CloneView[]) => busyLine(clones);

export function markWakeStart(
  db: DatabaseSync,
  leader: string,
  clone: {
    slot: number;
    lane: Lane;
    label: string;
    groups: readonly string[];
    summary: string;
  },
  now = Date.now(),
) {
  db.prepare(
    "INSERT OR REPLACE INTO leader_clones(leader,slot,lane,label,groups_json,summary,started_at) VALUES (?,?,?,?,?,?,?)",
  ).run(
    leader,
    clone.slot,
    clone.lane,
    clone.label,
    JSON.stringify(clone.groups),
    clone.summary,
    now,
  );
  const clones = clonesOf(db, leader);
  // 第一个分身起来时记唤醒开始；后来的只更新摘要。
  db.prepare(
    `UPDATE org_leaders SET wake_at=CASE WHEN wake_status='running' AND ?>1 THEN wake_at ELSE ? END,
      wake_ended_at=NULL,wake_status='running',wake_summary=?,wake_note=NULL,wakes=wakes+1 WHERE id=?`,
  ).run(clones.length, now, summaryOf(clones), idOf(leader));
}

export type WakeEnd = "done" | "failed" | "handed_off";

/**
 * 一个分身结束：删掉它那行；还有别的分身在跑就只更新摘要（失败次数照记），都结束了才写结局。
 * 处理完清零失败次数只在没有别的分身时做，免得别的分身的失败被抹掉、一直重试不转交。
 */
export function markWakeEnd(
  db: DatabaseSync,
  leader: string,
  slot: number,
  status: WakeEnd,
  failures: number,
  note: string | null,
  now = Date.now(),
) {
  db.prepare("DELETE FROM leader_clones WHERE leader=? AND slot=?").run(
    leader,
    slot,
  );
  const rest = clonesOf(db, leader);
  if (rest.length) {
    db.prepare(
      "UPDATE org_leaders SET wake_summary=?,wake_failures=CASE WHEN ?='done' THEN wake_failures ELSE ? END,wake_note=COALESCE(?,wake_note) WHERE id=?",
    ).run(summaryOf(rest), status, failures, note, idOf(leader));
    return;
  }
  db.prepare(
    "UPDATE org_leaders SET wake_ended_at=?,wake_status=?,wake_failures=?,wake_note=? WHERE id=?",
  ).run(now, status, failures, note, idOf(leader));
}

/** 服务重启时把上次没收尾的唤醒记成失败（进程已随旧服务停掉），清掉在跑的分身。 */
export function closeStaleWakes(db: DatabaseSync, now = Date.now()) {
  if (
    !one(
      db,
      "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='org_leaders'",
    )
  )
    return;
  db.exec("DELETE FROM leader_clones");
  db.prepare(
    "UPDATE org_leaders SET wake_ended_at=?,wake_status='failed',wake_note='服务重启，本次唤醒中断，事件稍后重投' WHERE wake_status='running'",
  ).run(now);
}

export const wakeFailures = (db: DatabaseSync, leader: string) =>
  one<{ wake_failures: number }>(
    db,
    "SELECT wake_failures FROM org_leaders WHERE id=?",
    idOf(leader),
  )?.wake_failures ?? 0;
