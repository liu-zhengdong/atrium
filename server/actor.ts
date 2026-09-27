import type { DatabaseSync } from "node:sqlite";
import { Problem } from "./problem.ts";
import { LOCAL_USER } from "../shared/user.ts";

const LEADER = /^a[1-9][0-9]*$/;

/**
 * 以谁的名义操作（`--as`）：不给就是本机用户 u1；给了 aN，须是组织树里某个未归档节点的 leader。
 * 组织运行时不再有长期身份表，「谁在操作」只看这两种短号，不接受名称或内部 ID。
 */
export function resolveActor(db: DatabaseSync, reference?: string): string {
  const value = (reference ?? "").trim() || LOCAL_USER;
  if (value === LOCAL_USER) return value;
  if (!LEADER.test(value))
    throw new Problem(400, "--as 应为 u1 或组织节点 leader 的短号，如 a1");
  const found = db
    .prepare(
      "SELECT 1 FROM org_nodes WHERE leader=? AND archived_at IS NULL LIMIT 1",
    )
    .get(value);
  if (!found)
    throw new Problem(
      404,
      `${value} 不是任何组织节点的 leader`,
      "not_found",
      undefined,
      "atrium org tree",
    );
  return value;
}
