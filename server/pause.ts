import type { DatabaseSync } from "node:sqlite";

/**
 * 一键停机（`atrium pause` / `resume`）：全局（all）、一个部门（oN 及下层）或一台主机（hN）。
 * 全局暂停时运行时不做任何自主动作：不派活（自动派发、排队拉起、重试换人）、不生成周期任务、
 * 不叫醒 leader 与后台秘书、合入与上线不推进；事件照常落库，但不投给等待的人。
 * 部门暂停只停那一块的派活、周期任务、合入与 leader；主机暂停只是不往那台派活与检查。
 * 在跑的执行者缺省跑完（`pause --stop` 才一并停），跑完不接新的。
 */

export type Pause = {
  scope: string;
  by: string;
  why: string | null;
  at: number;
};

export function ensurePauseTable(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS pauses (
    scope TEXT PRIMARY KEY CHECK(scope='all' OR scope GLOB 'o[1-9]*' OR scope GLOB 'h[1-9]*'),
    by TEXT NOT NULL, why TEXT, at INTEGER NOT NULL)`);
}

export function listPauses(db: DatabaseSync): Pause[] {
  return db
    .prepare("SELECT scope,by,why,at FROM pauses ORDER BY at,scope LIMIT 1000")
    .all() as Pause[];
}

const get = (db: DatabaseSync, scope: string) =>
  db.prepare("SELECT scope,by,why,at FROM pauses WHERE scope=?").get(scope) as
    Pause | undefined;

/** 暂停；已经暂停的保持原来的谁、何时、原因，返回 changed=false。 */
export function setPause(
  db: DatabaseSync,
  scope: string,
  by: string,
  why: string | null,
  now = Date.now(),
): { pause: Pause; changed: boolean } {
  const existing = get(db, scope);
  if (existing) return { pause: existing, changed: false };
  db.prepare("INSERT INTO pauses(scope,by,why,at) VALUES (?,?,?,?)").run(
    scope,
    by,
    why,
    now,
  );
  return { pause: { scope, by, why, at: now }, changed: true };
}

export function clearPause(db: DatabaseSync, scope: string): Pause | null {
  const existing = get(db, scope);
  if (existing) db.prepare("DELETE FROM pauses WHERE scope=?").run(scope);
  return existing ?? null;
}

export const globalPause = (db: DatabaseSync) => get(db, "all") ?? null;
export const hostPaused = (db: DatabaseSync, host: number) =>
  !!get(db, `h${host}`);

/** 这个部门（或它的任一上级）被暂停了没有；节点为空只看全局。 */
export function partPause(db: DatabaseSync, node: number | null): Pause | null {
  if (node === null) return null;
  const parts = new Map(
    listPauses(db)
      .filter((p) => p.scope.startsWith("o"))
      .map((p) => [Number(p.scope.slice(1)), p]),
  );
  if (!parts.size) return null;
  const parent = db.prepare("SELECT parent_id FROM org_nodes WHERE id=?");
  for (
    let id: number | null = node, depth = 0;
    id !== null && depth < 64;
    depth++
  ) {
    const found = parts.get(id);
    if (found) return found;
    id =
      (parent.get(id) as { parent_id: number | null } | undefined)?.parent_id ??
      null;
  }
  return null;
}

/** 这件任务此刻被什么暂停挡着：全局优先，其次它的归属部门（旧任务看 node_id）。 */
export function taskPause(db: DatabaseSync, taskId: number): Pause | null {
  const global = globalPause(db);
  if (global) return global;
  const row = db
    .prepare("SELECT COALESCE(part_id,node_id) AS part FROM tasks WHERE id=?")
    .get(taskId) as { part: number | null } | undefined;
  return partPause(db, row?.part ?? null);
}

/** 恢复这一条的命令。 */
export const resumeCommand = (pause: Pause) =>
  pause.scope === "all"
    ? "atrium resume"
    : `atrium resume --${pause.scope.startsWith("h") ? "host" : "part"} ${pause.scope}`;

/** 人话：「已暂停（全部，u1 09-28 10:00：原因）」。 */
export function pauseText(pause: Pause) {
  const at = new Date(pause.at);
  const two = (n: number) => String(n).padStart(2, "0");
  const time = `${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
  const what = pause.scope === "all" ? "全部" : pause.scope;
  return `已暂停（${what}，${pause.by} ${time}${pause.why ? `：${pause.why}` : ""}）`;
}

/**
 * 旧的暂停开关（主机 host pause、周期任务 schedule pause）并进这里，只迁一次：
 * 暂停的主机转成主机暂停；有暂停的周期任务就转成一次全局暂停（周期任务不再单独暂停），原因写明来源。
 * 迁完把旧字段清掉，之后不再读；旧库没有这些列时什么也不做。返回启动日志要写的话。
 */
export function migrateOldPauses(db: DatabaseSync, now = Date.now()): string[] {
  const columns = (table: string) =>
    new Set(
      (
        db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
      ).map((c) => c.name),
    );
  const notes: string[] = [];
  if (columns("hosts").has("paused")) {
    const hosts = db
      .prepare("SELECT id FROM hosts WHERE paused=1 ORDER BY id LIMIT 500")
      .all() as { id: number }[];
    for (const { id } of hosts)
      setPause(db, `h${id}`, "u1", "旧的 host pause 迁来", now);
    if (hosts.length) {
      db.prepare("UPDATE hosts SET paused=0 WHERE paused=1").run();
      notes.push(
        `旧的主机暂停并进一键停机：${hosts.map((h) => `h${h.id}`).join("、")} 仍暂停；恢复：atrium resume --host hN`,
      );
    }
  }
  if (columns("schedules").has("paused_at")) {
    const paused = db
      .prepare(
        "SELECT id FROM schedules WHERE paused_at IS NOT NULL AND removed_at IS NULL ORDER BY id LIMIT 500",
      )
      .all() as { id: number }[];
    if (paused.length) {
      const refs = paused.map((s) => `s${s.id}`).join("、");
      setPause(
        db,
        "all",
        "u1",
        `旧的周期任务暂停（${refs}）并进一键停机；恢复后照常到点生成，不要的先 atrium schedule rm sN`,
        now,
      );
      db.prepare(
        "UPDATE schedules SET paused_at=NULL WHERE paused_at IS NOT NULL",
      ).run();
      notes.push(
        `旧的周期任务暂停（${refs}）已转成全局暂停；看状态：atrium status，恢复：atrium resume`,
      );
    }
  }
  return notes;
}
