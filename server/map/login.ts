import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * 全景网页的登录（#322 第 4 步）：命令行（持用户令牌）换一个一次性链接，浏览器打开后换成本机会话 cookie。
 * - 链接里的 code 只能用一次、LINK_TTL_MS 内有效；会话 SESSION_TTL_MS 内有效，只能读全景。
 * - 库里只存哈希；表只有这两张，服务重启后会话照常有效（随时重启不打断看全景）。
 * - 有界：每次签发先删过期的，再只留最近 KEEP 条。
 */

export const LINK_TTL_MS = 2 * 60_000;
const SESSION_TTL_MS = 7 * 24 * 3600_000;
const COOKIE = "atrium_map";
const KEEP = 20;

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const TOKEN = /^[a-f0-9]{64}$/;

export class MapLogin {
  constructor(
    private db: DatabaseSync,
    private now: () => number = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS map_login (
      hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('link','session')),
      expires_at INTEGER NOT NULL);`);
  }

  private issue(kind: "link" | "session", ttl: number) {
    const token = randomBytes(32).toString("hex");
    const now = this.now();
    this.db.prepare("DELETE FROM map_login WHERE expires_at<=?").run(now);
    this.db
      .prepare(
        "DELETE FROM map_login WHERE kind=? AND hash NOT IN (SELECT hash FROM map_login WHERE kind=? ORDER BY expires_at DESC LIMIT ?)",
      )
      .run(kind, kind, KEEP - 1);
    this.db
      .prepare("INSERT INTO map_login(hash,kind,expires_at) VALUES(?,?,?)")
      .run(digest(token), kind, now + ttl);
    return { token, expires_at: now + ttl };
  }

  /** 签发一次性登录码。 */
  link() {
    return this.issue("link", LINK_TTL_MS);
  }

  /** 用登录码换会话：码只认一次，过期或用过都返回 null。 */
  exchange(code: unknown) {
    if (typeof code !== "string" || !TOKEN.test(code)) return null;
    const hash = digest(code);
    const row = this.db
      .prepare(
        "DELETE FROM map_login WHERE hash=? AND kind='link' RETURNING expires_at",
      )
      .get(hash) as { expires_at: number } | undefined;
    if (!row || row.expires_at <= this.now()) return null;
    return this.issue("session", SESSION_TTL_MS);
  }

  /** 请求头里的会话 cookie 是否有效。 */
  valid(cookieHeader: string | undefined) {
    const token = cookieOf(cookieHeader);
    if (!token) return false;
    const row = this.db
      .prepare(
        "SELECT expires_at FROM map_login WHERE hash=? AND kind='session'",
      )
      .get(digest(token)) as { expires_at: number } | undefined;
    return !!row && row.expires_at > this.now();
  }
}

export function cookieOf(header: string | undefined): string | null {
  for (const part of (header ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    const value = rest.join("=");
    if (name === COOKIE && TOKEN.test(value)) return value;
  }
  return null;
}

export const sessionCookie = (token: string, ttl = SESSION_TTL_MS) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ttl / 1000)}`;
