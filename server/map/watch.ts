import type { DatabaseSync } from "node:sqlite";

/**
 * 全景网页的变更检测：全服务一份。
 * 相关表的增删改把 `map_revision.n` 加一；检测只读这一行（主键点查），不扫任务/收件箱/交付。
 * SSE 连接订阅同一份定时器，检测次数与打开页数无关。
 */

const WATCHED = [
  "tasks",
  "task_events",
  "org_nodes",
  "org_docs",
  "org_points",
  "task_also",
  "task_queue",
  "job_roles",
  "org_skills",
  "task_deliveries",
  "patrol_findings",
  "org_leaders",
  "task_inbox",
  "memos",
  "decisions",
  "choices",
  "choice_options",
  "choice_comments",
  "choice_settings",
  "materials",
] as const;

/** 检测用的语句：主键点查，查询计划不扫业务表。 */
export const MAP_REVISION_SQL = "SELECT n FROM map_revision WHERE k=1";

const ready = new WeakSet<DatabaseSync>();

const hasTable = (db: DatabaseSync, name: string) =>
  !!db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);

function createRevisionTable(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS map_revision (
      k INTEGER PRIMARY KEY CHECK (k = 1),
      n INTEGER NOT NULL);
    INSERT OR IGNORE INTO map_revision(k, n) VALUES (1, 0);`);
}

function attachTriggers(db: DatabaseSync) {
  for (const table of WATCHED) {
    if (!hasTable(db, table)) continue;
    for (const [event, suffix] of [
      ["INSERT", "i"],
      ["UPDATE", "u"],
      ["DELETE", "d"],
    ] as const)
      db.exec(
        `CREATE TRIGGER IF NOT EXISTS map_rev_${table}_${suffix}
         AFTER ${event} ON ${table}
         BEGIN UPDATE map_revision SET n = n + 1 WHERE k = 1; END`,
      );
  }
}

export function ensureMapWatch(db: DatabaseSync) {
  if (ready.has(db)) return;
  createRevisionTable(db);
  attachTriggers(db);
  ready.add(db);
}

const readRevision = (db: DatabaseSync) => {
  const row = db.prepare(MAP_REVISION_SQL).get() as { n: number } | undefined;
  return row?.n ?? 0;
};

/** 当前全景数据版本；表还不存在时先建好。 */
export function mapRevision(db: DatabaseSync): number {
  ensureMapWatch(db);
  return readRevision(db);
}

/** 给网页与既有测试用的指纹：版本号变成字符串。 */
export function mapSignature(db: DatabaseSync): string {
  return String(mapRevision(db));
}

export type MapWatchEvent = "changed" | "ping";
export type MapRepeat = (ms: number, tick: () => void) => () => void;
export type MapWatch = {
  subscribe(listener: (event: MapWatchEvent) => void): () => void;
  close(): void;
  readonly detectCount: number;
};

const defaultRepeat: MapRepeat = (ms, tick) => {
  const timer = setInterval(tick, ms);
  return () => clearInterval(timer);
};

export function startMapWatch(
  db: DatabaseSync,
  options: {
    pollMs?: number;
    pingEvery?: number;
    detect?: () => string | number;
    repeat?: MapRepeat;
  } = {},
): MapWatch {
  ensureMapWatch(db);
  const pollMs = options.pollMs ?? 1500;
  const pingEvery = options.pingEvery ?? 10;
  const detect = options.detect ?? (() => readRevision(db));
  const repeat = options.repeat ?? defaultRepeat;
  const listeners = new Set<(event: MapWatchEvent) => void>();
  let last: string | number | undefined;
  let beats = 0;
  let detectCount = 0;
  let stop: (() => void) | undefined;
  let closed = false;

  const read = () => {
    detectCount++;
    return detect();
  };
  const emit = (event: MapWatchEvent) => {
    for (const listener of [...listeners]) listener(event);
  };
  const tick = () => {
    const now = read();
    if (now !== last) {
      last = now;
      beats = 0;
      emit("changed");
    } else if (++beats % pingEvery === 0) emit("ping");
  };
  const halt = () => {
    stop?.();
    stop = undefined;
    last = undefined;
  };

  return {
    get detectCount() {
      return detectCount;
    },
    subscribe(listener) {
      if (closed) return () => {};
      listeners.add(listener);
      if (listeners.size === 1 && !stop) {
        last = read();
        stop = repeat(pollMs, tick);
      }
      return () => {
        if (!listeners.delete(listener)) return;
        if (!listeners.size) halt();
      };
    },
    close() {
      closed = true;
      listeners.clear();
      halt();
    },
  };
}
