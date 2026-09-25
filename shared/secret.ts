import { createHash, timingSafeEqual } from "node:crypto";

/** Compare tokens or their stored digests without leaking their length to timingSafeEqual. */
export function sameSecret(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}
