import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { Store } from "./store.ts";
import { Problem } from "./problem.ts";

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_MS = 60 * 1000;
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("hex");
const equal = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Write the CLI's only copy of the bearer without exposing it in an HTTP response. */
function atomicSecret(path: string, value: string) {
  const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, `${value}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
    chmodSync(path, 0o600);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

export const userTokenPath = (data: string) => join(data, "user-token");
export const cookieName = (data: string) =>
  `atrium_${digest(resolve(data)).slice(0, 16)}`;

/** Authentication state is durable; login codes are deliberately volatile and one-use. */
export class UserAuth {
  readonly name: string;
  private codes = new Map<string, number>();
  constructor(
    private store: Store,
    private data: string,
  ) {
    this.name = cookieName(data);
    mkdirSync(data, { recursive: true, mode: 0o700 });
    store.db.exec(`CREATE TABLE IF NOT EXISTS user_auth (
      id INTEGER PRIMARY KEY CHECK(id=1), token_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS web_sessions (
      token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS web_sessions_expires ON web_sessions(expires_at);
      CREATE TABLE IF NOT EXISTS inbox_tokens (
      agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL);`);
    if (!store.one("SELECT id FROM user_auth WHERE id=1")) {
      const path = userTokenPath(data);
      // Recover from an interrupted first boot: the file is the only user copy.
      let token = existsSync(path) ? readFileSync(path, "utf8").trim() : null;
      if (token !== null && !/^[a-f0-9]{64}$/.test(token)) {
        const preserved = `${path}.invalid-${randomBytes(6).toString("hex")}`;
        renameSync(path, preserved);
        chmodSync(preserved, 0o600);
        console.warn(
          `用户令牌文件无效，原件已保留：${preserved}；已生成新令牌`,
        );
        token = null;
      }
      if (!token) {
        token = secret();
        atomicSecret(path, token);
      }
      store.run(
        "INSERT INTO user_auth(id,token_hash) VALUES(1,?)",
        digest(token),
      );
    }
  }

  validUser(value: string | undefined) {
    const token = /^Bearer ([a-f0-9]{64})$/i.exec(value ?? "")?.[1];
    const row = this.store.one<{ token_hash: string }>(
      "SELECT token_hash FROM user_auth WHERE id=1",
    );
    return !!token && !!row && equal(digest(token), row.token_hash);
  }

  validSession(raw: string | undefined): boolean {
    const token = raw
      ?.split(/;\s*/)
      .find((part) => part.startsWith(`${this.name}=`))
      ?.slice(this.name.length + 1);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return false;
    const now = Date.now();
    const row = this.store.one<{ expires_at: number }>(
      "SELECT expires_at FROM web_sessions WHERE token_hash=?",
      digest(token),
    );
    if (!row || row.expires_at <= now) return false;
    // Extend persisted expiry at most once a day; the browser cookie is refreshed on every request.
    if (row.expires_at - now < SESSION_MS - 24 * 60 * 60 * 1000)
      this.store.run(
        "UPDATE web_sessions SET expires_at=? WHERE token_hash=?",
        now + SESSION_MS,
        digest(token),
      );
    return true;
  }

  cookie(raw: string) {
    return `${this.name}=${raw}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`;
  }
  refreshCookie(raw: string | undefined) {
    const token = raw
      ?.split(/;\s*/)
      .find((part) => part.startsWith(`${this.name}=`))
      ?.slice(this.name.length + 1);
    return token && /^[a-f0-9]{64}$/.test(token)
      ? this.cookie(token)
      : undefined;
  }
  clearCookie() {
    return `${this.name}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
  }
  issueCode() {
    const now = Date.now();
    for (const [key, expiry] of this.codes)
      if (expiry <= now) this.codes.delete(key);
    const code = secret();
    this.codes.set(digest(code), now + CODE_MS);
    return code;
  }
  claimCode(code: string) {
    const key = digest(code);
    const expiry = this.codes.get(key);
    this.codes.delete(key);
    if (!expiry || expiry <= Date.now())
      throw new Problem(401, "登录链接已失效，请重新运行 atrium open");
    const session = secret();
    this.store.run("DELETE FROM web_sessions WHERE expires_at<=?", Date.now());
    this.store.run(
      "INSERT INTO web_sessions(token_hash,expires_at) VALUES(?,?)",
      digest(session),
      Date.now() + SESSION_MS,
    );
    return this.cookie(session);
  }
  logout() {
    this.store.run("DELETE FROM web_sessions");
    this.codes.clear();
  }
  rotate() {
    const token = secret();
    atomicSecret(userTokenPath(this.data), token);
    this.store.transaction(() => {
      this.store.run(
        "UPDATE user_auth SET token_hash=? WHERE id=1",
        digest(token),
      );
      this.store.run("DELETE FROM web_sessions");
    });
    this.codes.clear();
  }
  validHook(agentId: string, token: string) {
    if (!/^[a-f0-9]{64}$/.test(token)) return false;
    const row = this.store.one<{ token_hash: string }>(
      "SELECT token_hash FROM inbox_tokens WHERE agent_id=?",
      agentId,
    );
    return !!row && equal(digest(token), row.token_hash);
  }
  setHook(agentId: string, tokenHash: string | null) {
    if (tokenHash && !/^[a-f0-9]{64}$/.test(tokenHash))
      throw new Problem(400, "推送令牌摘要无效");
    this.store.agent(agentId);
    if (tokenHash)
      this.store.run(
        "INSERT INTO inbox_tokens(agent_id,token_hash) VALUES(?,?) ON CONFLICT(agent_id) DO UPDATE SET token_hash=excluded.token_hash",
        agentId,
        tokenHash,
      );
    else this.store.run("DELETE FROM inbox_tokens WHERE agent_id=?", agentId);
  }
  hookHash(agentId: string) {
    return (
      this.store.one<{ token_hash: string }>(
        "SELECT token_hash FROM inbox_tokens WHERE agent_id=?",
        agentId,
      )?.token_hash ?? null
    );
  }
}
