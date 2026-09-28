import type { DatabaseSync } from "node:sqlite";
import { all, one } from "../org/model.ts";
import type { MemoTarget } from "../leaders/clones.ts";
import { writeMemo } from "./store.ts";

/**
 * 备忘分段（t275）：同一位 leader 有几个分身同时在跑时，各自只写自己这一段（按认领的事，如「t197」「日常」），
 * 不互相覆盖；只剩一个分身时它写的备忘就是合并——覆盖主备忘，清掉它开始时已看到的各段。
 * `memo_parts` 一位一段一行；每段上限同主备忘（MEMO_MAX）。写到哪由 leaders/clones.ts 的 memoTarget 判。
 * 旧运行时没有同名表。
 */

export function ensureMemoPartTables(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS memo_parts (
    owner TEXT NOT NULL, part TEXT NOT NULL,
    body TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(owner, part))`);
}

export type MemoPart = { part: string; body: string; updated_at: number };

const hasParts = (db: DatabaseSync) =>
  !!one(
    db,
    "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='memo_parts'",
  );

export function readMemoParts(db: DatabaseSync, owner: string): MemoPart[] {
  if (!hasParts(db)) return [];
  return all<MemoPart>(
    db,
    "SELECT part,body,updated_at FROM memo_parts WHERE owner=? ORDER BY updated_at,part LIMIT 20",
    owner,
  );
}

/** 按 memoTarget 写：一段、合并（覆盖主备忘并清掉看过的段）或只写主备忘。body 须已经过 memoText。 */
export function writeMemoTo(
  db: DatabaseSync,
  owner: string,
  body: string,
  target: MemoTarget,
  now = Date.now(),
) {
  ensureMemoPartTables(db);
  if (target.kind === "part") {
    db.prepare(
      "INSERT INTO memo_parts(owner,part,body,updated_at) VALUES(?,?,?,?) ON CONFLICT(owner,part) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at",
    ).run(owner, target.part, body, now);
    return;
  }
  writeMemo(db, owner, body, now);
  if (target.kind === "merge")
    db.prepare(
      "DELETE FROM memo_parts WHERE owner=? AND (updated_at<? OR part=?)",
    ).run(owner, target.before, target.part ?? "");
}
