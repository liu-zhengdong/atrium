import { randomBytes } from "node:crypto";
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { restrictToOwner } from "../platform/index.ts";
import {
  DEFAULT_SETTINGS,
  parseBatch,
  parseProxy,
  parseQuiet,
  quietText,
  type Push,
  type PushKind,
  type Settings,
} from "./model.ts";

/**
 * 推送的持久化：凭据文件 `<ATRIUM_DATA>/telegram.json`（0600；bot token、绑定的 chat、绑定码、
 * 代理与免打扰设置——代理可能带密码，一并放这里），库里的待发队列 notify_outbox，
 * 和选项单卡片 notify_choice_cards（卡片是哪条消息、点过哪些选项、回复的说明）。
 * token 只在这个文件里，不进库、日志、事件与提示词；不碰用户钥匙串。
 */

export type Credential = {
  token: string;
  /** 机器人用户名（getMe 取的），给用户看「给 @xxx 发消息」。 */
  bot: string;
  chat_id: number | null;
  /** 绑定码与过期时刻；绑定成功后清掉。 */
  bind: { code: string; expires_at: number } | null;
};

export type NotifyFile = {
  credential: Credential | null;
  settings: Settings;
};

export const telegramFile = (data: string) => join(data, "telegram.json");

const EMPTY: NotifyFile = { credential: null, settings: DEFAULT_SETTINGS };

/** 读凭据文件；没有为空；写坏了挪开留档并记日志，当没配过（启动不因它失败）。 */
export function readNotifyFile(data: string): NotifyFile {
  const path = telegramFile(data);
  if (!existsSync(path)) return EMPTY;
  try {
    return parseFile(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    const kept = `${path}.invalid-${randomBytes(4).toString("hex")}`;
    try {
      renameSync(path, kept);
      restrictToOwner(kept);
    } catch {
      // 挪不开也不挡启动：下次写入会覆盖。
    }
    console.warn(`推送凭据文件无法读取，已挪到 ${kept}；推送按未配置处理`);
    return EMPTY;
  }
}

function parseFile(value: unknown): NotifyFile {
  const input = value as Record<string, unknown>;
  if (!input || typeof input !== "object") throw new Error("not an object");
  const raw = (input.settings ?? {}) as Record<string, unknown>;
  const settings: Settings = {
    enabled: raw.enabled !== false,
    quiet:
      raw.quiet && typeof raw.quiet === "string" ? parseQuiet(raw.quiet) : null,
    batch_seconds:
      raw.batch_seconds === undefined
        ? DEFAULT_SETTINGS.batch_seconds
        : parseBatch(raw.batch_seconds),
    proxy:
      typeof raw.proxy === "string" && raw.proxy ? parseProxy(raw.proxy) : null,
  };
  const c = input.credential as Record<string, unknown> | null | undefined;
  if (!c) return { credential: null, settings };
  if (typeof c.token !== "string" || typeof c.bot !== "string")
    throw new Error("bad credential");
  const bind = c.bind as { code?: unknown; expires_at?: unknown } | null;
  return {
    credential: {
      token: c.token,
      bot: c.bot,
      chat_id: typeof c.chat_id === "number" ? c.chat_id : null,
      bind:
        bind &&
        typeof bind.code === "string" &&
        typeof bind.expires_at === "number"
          ? { code: bind.code, expires_at: bind.expires_at }
          : null,
    },
    settings,
  };
}

/** 原子写入，只留给本人（Unix 0600）。 */
export function writeNotifyFile(data: string, file: NotifyFile) {
  const path = telegramFile(data);
  const { quiet, ...rest } = file.settings;
  const text = JSON.stringify(
    {
      credential: file.credential,
      settings: {
        ...rest,
        quiet: quiet ? quietText(quiet) : null,
      },
    },
    null,
    2,
  );
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, `${text}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
    restrictToOwner(path);
  } finally {
    rmSync(temp, { force: true });
  }
}

// ---- 待发队列 ----

export function ensureNotifyTables(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS notify_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      ref TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      retry_at INTEGER,
      sent_at INTEGER,
      failed_at INTEGER,
      error TEXT);
    CREATE INDEX IF NOT EXISTS notify_outbox_pending ON notify_outbox(id) WHERE sent_at IS NULL AND failed_at IS NULL;
    CREATE INDEX IF NOT EXISTS notify_outbox_done ON notify_outbox(created_at) WHERE sent_at IS NOT NULL OR failed_at IS NOT NULL;
    CREATE TABLE IF NOT EXISTS notify_choice_cards (
      choice_id INTEGER PRIMARY KEY,
      message_id INTEGER,
      picks TEXT NOT NULL DEFAULT '',
      note TEXT,
      updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS notify_choice_cards_message ON notify_choice_cards(message_id);
    CREATE INDEX IF NOT EXISTS notify_choice_cards_updated ON notify_choice_cards(updated_at);`);
}

export type Queued = Push & {
  id: number;
  created_at: number;
  attempts: number;
  retry_at: number | null;
};

/** 排进待发队列；同一去重键只排一次。返回是否新排进。 */
export function enqueue(db: DatabaseSync, push: Push, now: number) {
  return (
    db
      .prepare(
        "INSERT OR IGNORE INTO notify_outbox(key,kind,ref,title,created_at) VALUES (?,?,?,?,?)",
      )
      .run(push.key, push.kind, push.ref, push.title, now).changes > 0
  );
}

/** 待发的（最多 limit 条），按排队先后。 */
export function pending(db: DatabaseSync, limit = 100): Queued[] {
  return (
    db
      .prepare(
        "SELECT id,key,kind,ref,title,created_at,attempts,retry_at FROM notify_outbox WHERE sent_at IS NULL AND failed_at IS NULL ORDER BY id LIMIT ?",
      )
      .all(limit) as (Omit<Queued, "kind"> & { kind: string })[]
  ).map((row) => ({ ...row, kind: row.kind as PushKind }));
}

export function pendingCount(db: DatabaseSync) {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM notify_outbox WHERE sent_at IS NULL AND failed_at IS NULL",
      )
      .get() as { n: number }
  ).n;
}

export function markSent(
  db: DatabaseSync,
  ids: readonly number[],
  now: number,
) {
  const statement = db.prepare(
    "UPDATE notify_outbox SET sent_at=?,error=NULL WHERE id=?",
  );
  for (const id of ids) statement.run(now, id);
}

export function markRetry(
  db: DatabaseSync,
  ids: readonly number[],
  attempts: number,
  at: number,
  error: string,
) {
  const statement = db.prepare(
    "UPDATE notify_outbox SET attempts=?,retry_at=?,error=? WHERE id=?",
  );
  for (const id of ids) statement.run(attempts, at, error, id);
}

export function markFailed(
  db: DatabaseSync,
  ids: readonly number[],
  attempts: number,
  now: number,
  error: string,
) {
  const statement = db.prepare(
    "UPDATE notify_outbox SET attempts=?,failed_at=?,error=? WHERE id=?",
  );
  for (const id of ids) statement.run(attempts, now, error, id);
}

/** 不再推的（选项单已经拍板了）直接从队列里拿掉。 */
export function drop(db: DatabaseSync, ids: readonly number[]) {
  const statement = db.prepare("DELETE FROM notify_outbox WHERE id=?");
  for (const id of ids) statement.run(id);
}

/** 发完或放弃的只留 7 天，队列不随时间增长。 */
export function prune(db: DatabaseSync, now: number) {
  db.prepare(
    "DELETE FROM notify_outbox WHERE (sent_at IS NOT NULL OR failed_at IS NOT NULL) AND created_at<?",
  ).run(now - 7 * 24 * 3600_000);
}

// ---- 选项单卡片 ----

export type Card = {
  choice: string;
  message_id: number | null;
  picks: number[];
  note: string | null;
};

type CardRow = {
  choice_id: number;
  message_id: number | null;
  picks: string;
  note: string | null;
};

const cardOf = (row: CardRow): Card => ({
  choice: `c${row.choice_id}`,
  message_id: row.message_id,
  picks: row.picks ? row.picks.split(",").map(Number) : [],
  note: row.note,
});

export function getCard(db: DatabaseSync, choice: string): Card | null {
  const row = db
    .prepare(
      "SELECT choice_id,message_id,picks,note FROM notify_choice_cards WHERE choice_id=?",
    )
    .get(Number(choice.slice(1))) as CardRow | undefined;
  return row ? cardOf(row) : null;
}

/** 按消息找卡片（用户回复的是哪张）。 */
export function cardByMessage(db: DatabaseSync, message: number): Card | null {
  const row = db
    .prepare(
      "SELECT choice_id,message_id,picks,note FROM notify_choice_cards WHERE message_id=? ORDER BY updated_at DESC LIMIT 1",
    )
    .get(message) as CardRow | undefined;
  return row ? cardOf(row) : null;
}

/** 记卡片：给了的字段才改，没有就新建。 */
export function saveCard(
  db: DatabaseSync,
  choice: string,
  patch: Partial<Omit<Card, "choice">>,
  now: number,
) {
  const card = getCard(db, choice) ?? {
    choice,
    message_id: null,
    picks: [],
    note: null,
  };
  const next = { ...card, ...patch };
  db.prepare(
    `INSERT INTO notify_choice_cards(choice_id,message_id,picks,note,updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(choice_id) DO UPDATE SET message_id=excluded.message_id,picks=excluded.picks,note=excluded.note,updated_at=excluded.updated_at`,
  ).run(
    Number(choice.slice(1)),
    next.message_id,
    next.picks.join(","),
    next.note,
    now,
  );
  return next;
}

/** 还没拍板的选项单里、推过卡片的（最多 limit 份，新的在前）；给「没用回复的说明归谁」判定。 */
export function openCards(db: DatabaseSync, limit = 10): string[] {
  return (
    db
      .prepare(
        `SELECT k.choice_id AS id FROM notify_choice_cards k JOIN choices c ON c.id=k.choice_id
         WHERE k.message_id IS NOT NULL AND c.status='open' ORDER BY k.updated_at DESC LIMIT ?`,
      )
      .all(limit) as { id: number }[]
  ).map((row) => `c${row.id}`);
}

/** 拍过板、卡片已改成结果：不再记（之后点旧按钮按选项单状态回「已拍板」）。 */
export function deleteCard(db: DatabaseSync, choice: string) {
  db.prepare("DELETE FROM notify_choice_cards WHERE choice_id=?").run(
    Number(choice.slice(1)),
  );
}

/** 换了机器人或聊天：旧消息的卡片作废。 */
export function clearCards(db: DatabaseSync) {
  db.exec("DELETE FROM notify_choice_cards");
}

/** 30 天没动过的卡片清掉，表不随时间增长。 */
export function pruneCards(db: DatabaseSync, now: number) {
  db.prepare("DELETE FROM notify_choice_cards WHERE updated_at<?").run(
    now - 30 * 24 * 3600_000,
  );
}

/** 最近一次发出与最近一次失败，给 notify 状态看。 */
export function lastOutcome(db: DatabaseSync) {
  const sent = db
    .prepare("SELECT MAX(sent_at) AS at FROM notify_outbox")
    .get() as { at: number | null };
  const failed = db
    .prepare(
      "SELECT error, COALESCE(failed_at, created_at) AS at FROM notify_outbox WHERE error IS NOT NULL ORDER BY id DESC LIMIT 1",
    )
    .get() as { error: string; at: number } | undefined;
  return { sent_at: sent.at, error: failed ?? null };
}
