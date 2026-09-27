import { createHash, randomBytes } from "node:crypto";
import { sameSecret } from "../shared/secret.ts";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("hex");

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

/** 用户凭据只有一份持久令牌：库里存哈希，原文只在数据目录的 user-token 文件里。 */
export class UserAuth {
  constructor(
    private db: DatabaseSync,
    private data: string,
  ) {
    mkdirSync(data, { recursive: true, mode: 0o700 });
    db.exec(`CREATE TABLE IF NOT EXISTS user_auth (
      id INTEGER PRIMARY KEY CHECK(id=1), token_hash TEXT NOT NULL);`);
    if (!db.prepare("SELECT id FROM user_auth WHERE id=1").get()) {
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
      db.prepare("INSERT INTO user_auth(id,token_hash) VALUES(1,?)").run(
        digest(token),
      );
    }
  }

  validUser(value: string | undefined) {
    const token = /^Bearer ([a-f0-9]{64})$/i.exec(value ?? "")?.[1];
    const row = this.db
      .prepare("SELECT token_hash FROM user_auth WHERE id=1")
      .get() as { token_hash: string } | undefined;
    return !!token && !!row && sameSecret(digest(token), row.token_hash);
  }

  rotate() {
    const token = secret();
    atomicSecret(userTokenPath(this.data), token);
    this.db
      .prepare("UPDATE user_auth SET token_hash=? WHERE id=1")
      .run(digest(token));
  }
}
