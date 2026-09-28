import { createHash, randomBytes } from "node:crypto";
import { sameSecret } from "../../shared/secret.ts";

/**
 * leader 令牌：每次唤醒（每个分身，t275）签发一枚，只在内存里存哈希，唤醒结束即作废；服务重启后全部失效
 * （在跑的 leader 进程随旧服务停掉）。令牌形如 `aN.<64 位十六进制>`，按 aN 找到它的几枚再逐枚比对。
 * 同时记着这枚属于哪个分身、认领了哪些组，服务端据此分段写备忘、拦下动别的分身认领的任务。
 */

const FORMAT = /^Bearer (a[1-9][0-9]{0,8})\.([a-f0-9]{64})$/i;
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export type CloneClaim = {
  slot: number;
  label: string;
  groups: readonly string[];
  /** 唤醒开始时刻：合并备忘时只清这之前写的分段。 */
  started: number;
};

type Entry = { hash: string; expires: number; clone: CloneClaim };

export class LeaderTokens {
  private readonly tokens = new Map<string, Map<number, Entry>>();

  constructor(private readonly now: () => number = Date.now) {}

  /** 签发；同一分身同时只有一枚，重签即作废旧的。不给分身按 1 号（只有一个唤醒时）。 */
  issue(
    leader: string,
    ttlMs: number,
    clone: CloneClaim = {
      slot: 1,
      label: "",
      groups: [],
      started: this.now(),
    },
  ): string {
    const secret = randomBytes(32).toString("hex");
    const mine = this.tokens.get(leader) ?? new Map<number, Entry>();
    mine.set(clone.slot, {
      hash: digest(secret),
      expires: this.now() + ttlMs,
      clone,
    });
    this.tokens.set(leader, mine);
    return `${leader}.${secret}`;
  }

  revoke(leader: string, slot = 1) {
    const mine = this.tokens.get(leader);
    mine?.delete(slot);
    if (mine && !mine.size) this.tokens.delete(leader);
  }

  /** 看起来像 leader 令牌（不论真假）：认证时据此走 leader 分支，不再当用户令牌。 */
  static looksLike(authorization: string | undefined) {
    return FORMAT.test(authorization ?? "");
  }

  /** 有效时返回 aN 与它属于哪个分身，否则 null。 */
  identify(
    authorization: string | undefined,
  ): { leader: string; clone: CloneClaim } | null {
    const match = FORMAT.exec(authorization ?? "");
    if (!match) return null;
    const leader = match[1]!;
    const hash = digest(match[2]!.toLowerCase());
    for (const entry of this.tokens.get(leader)?.values() ?? [])
      if (entry.expires >= this.now() && sameSecret(hash, entry.hash))
        return { leader, clone: entry.clone };
    return null;
  }

  /** 有效时返回 aN，否则 null。 */
  verify(authorization: string | undefined): string | null {
    return this.identify(authorization)?.leader ?? null;
  }

  /** 同一 leader 此刻另外几个分身（令牌没过期的）。 */
  siblings(leader: string, slot: number): CloneClaim[] {
    return [...(this.tokens.get(leader)?.values() ?? [])]
      .filter((e) => e.clone.slot !== slot && e.expires >= this.now())
      .map((e) => e.clone);
  }
}
