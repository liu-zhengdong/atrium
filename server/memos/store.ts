import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { all, one } from "../org/model.ts";

/**
 * 固定身份（秘书 secretary、leader aN）的备忘与决定记录的存储（#355 状态统一，t97）。
 * - 备忘：每位一份，覆盖写、有上限，写「在等什么、下次先看什么」这类当前状态；
 *   leader 的 `leader edit --memo` 与 `memo edit --as aN` 写同一行。
 * - 决定记录：追加式，短号 dN 全局持久、不复用（AUTOINCREMENT），被推翻的指向新决定。
 * 这里只管建表与读写备忘；身份解析在 owner.ts，决定记录在 decisions.ts。
 */

/** 备忘是跨唤醒、跨会话的连续性；有上限，超了让写的人精简，不静默截断。 */
export const MEMO_MAX = 2000;

export function ensureMemoTables(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS memos (
    owner TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    decided_on TEXT NOT NULL,
    decided_by TEXT NOT NULL,
    text TEXT NOT NULL,
    why TEXT NOT NULL,
    issue INTEGER, node_id INTEGER, task_id INTEGER,
    superseded_by INTEGER, superseded_at INTEGER,
    created_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS decisions_owner ON decisions(owner,superseded_by,decided_on,id);
  CREATE INDEX IF NOT EXISTS decisions_superseded ON decisions(superseded_by);`);
  // 早先 leader 备忘存在 org_leaders.memo：没迁过的搬过来，之后以 memos 为准（幂等）。
  const legacy = one(
    db,
    "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='org_leaders'",
  );
  if (legacy)
    db.exec(
      "INSERT OR IGNORE INTO memos(owner,body,updated_at) SELECT 'a'||id,memo,updated_at FROM org_leaders WHERE memo<>''",
    );
}

/** 备忘长度判定：纯函数，超了返回提示。 */
export function memoProblem(memo: string, max = MEMO_MAX): string | null {
  const size = Array.from(memo).length;
  return size > max
    ? `memo: 备忘 ${size} 字，超过上限 ${max} 字；请精简（留结论与待办，删过程）后再写`
    : null;
}

/** 校验并规整备忘正文；超了报用法错误并给看现状的命令。 */
export function memoText(value: unknown, next?: string): string {
  if (typeof value !== "string")
    throw new Problem(400, "memo: 应为文本", "usage");
  const text = value.trim();
  const problem = memoProblem(text);
  if (problem) throw new Problem(400, problem, "usage", undefined, next);
  return text;
}

export type Memo = { body: string; updated_at: number | null };

export function readMemo(db: DatabaseSync, owner: string): Memo {
  const row = one<{ body: string; updated_at: number }>(
    db,
    "SELECT body,updated_at FROM memos WHERE owner=?",
    owner,
  );
  return row ?? { body: "", updated_at: null };
}

/** 多位的备忘一次读出（leader 列表用）。 */
export function readMemos(db: DatabaseSync): Map<string, Memo> {
  return new Map(
    all<{ owner: string; body: string; updated_at: number }>(
      db,
      "SELECT owner,body,updated_at FROM memos ORDER BY owner LIMIT 1000",
    ).map((r) => [r.owner, { body: r.body, updated_at: r.updated_at }]),
  );
}

/** 覆盖写；body 须已经过 memoText。 */
export function writeMemo(
  db: DatabaseSync,
  owner: string,
  body: string,
  now = Date.now(),
) {
  db.prepare(
    "INSERT INTO memos(owner,body,updated_at) VALUES(?,?,?) ON CONFLICT(owner) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at",
  ).run(owner, body, now);
}
