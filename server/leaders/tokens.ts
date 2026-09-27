import { createHash, randomBytes } from "node:crypto";
import { sameSecret } from "../../shared/secret.ts";

/**
 * leader 令牌：每次唤醒签发一枚，只在内存里存哈希，唤醒结束即作废；服务重启后全部失效
 * （在跑的 leader 进程随旧服务停掉）。令牌形如 `aN.<64 位十六进制>`，按 aN 找到哈希再比对。
 */

const FORMAT = /^Bearer (a[1-9][0-9]{0,8})\.([a-f0-9]{64})$/i;
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export class LeaderTokens {
  private readonly tokens = new Map<
    string,
    { hash: string; expires: number }
  >();

  constructor(private readonly now: () => number = Date.now) {}

  /** 签发；同一 leader 同时只有一枚，重签即作废旧的。 */
  issue(leader: string, ttlMs: number): string {
    const secret = randomBytes(32).toString("hex");
    this.tokens.set(leader, {
      hash: digest(secret),
      expires: this.now() + ttlMs,
    });
    return `${leader}.${secret}`;
  }

  revoke(leader: string) {
    this.tokens.delete(leader);
  }

  /** 看起来像 leader 令牌（不论真假）：认证时据此走 leader 分支，不再当用户令牌。 */
  static looksLike(authorization: string | undefined) {
    return FORMAT.test(authorization ?? "");
  }

  /** 有效时返回 aN，否则 null。 */
  verify(authorization: string | undefined): string | null {
    const match = FORMAT.exec(authorization ?? "");
    if (!match) return null;
    const leader = match[1]!;
    const entry = this.tokens.get(leader);
    if (!entry || entry.expires < this.now()) return null;
    return sameSecret(digest(match[2]!.toLowerCase()), entry.hash)
      ? leader
      : null;
  }
}
