import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { atomically } from "../tasks/ledger-model.ts";
import { addPoint, addPointSource, POINT_LIMITS } from "../org/points.ts";
import {
  decisionRef,
  getDecision,
  linkNodes,
  nodeAddresses,
  parseDecisionRef,
  requireRow,
  who,
  type Decision,
  type Row,
} from "./decisions.ts";

/**
 * 整理决定记录（t211）：补挂节点（tag）、标／取消「原则」（mark）、沉淀成要点（settle）、撤销误标的推翻（unsupersede）。
 * 只挪信息、不删：沉淀的标「已沉淀到 kN」、要点记来源 dN；撤销推翻记一笔谁、为什么（decision_changes）。
 * 用户令牌（用户本人与秘书）能整理任何一份；leader 令牌只能整理自己那份（manageVerdict）。判定是纯函数。
 */

export const CHANGE_WHY_MAX = 300;

const usage = (message: string, next?: string) =>
  new Problem(400, message, "usage", undefined, next);

/** leader 只能整理自己那份；用户令牌（leader 为 undefined）不限。纯函数。 */
export function manageVerdict(
  leader: string | undefined,
  owner: string,
  id: number,
): string | null {
  if (!leader || leader === owner) return null;
  return `${decisionRef(id)} 是 ${who(owner)} 的决定记录，${leader} 只能整理自己的`;
}

/** 沉淀判定（纯函数）：被推翻的、已沉淀过的不再沉淀。 */
export function settleVerdict(
  row: Pick<Row, "id" | "superseded_by" | "settled_point">,
): string | null {
  if (row.superseded_by !== null)
    return `${decisionRef(row.id)} 已被 ${decisionRef(row.superseded_by)} 推翻，沉淀有效的那条`;
  if (row.settled_point !== null)
    return `${decisionRef(row.id)} 已沉淀到 k${row.settled_point}`;
  return null;
}

/** 撤销推翻判定（纯函数）：只有被推翻的才能撤销。 */
export function unsupersedeVerdict(
  row: Pick<Row, "id" | "superseded_by">,
): string | null {
  return row.superseded_by === null
    ? `${decisionRef(row.id)} 没被推翻，不用撤销`
    : null;
}

/** 请求体：只认列出的字段。 */
function bodyOf(value: unknown, keys: readonly string[]) {
  const body = (value ?? {}) as Record<string, unknown>;
  if (typeof body !== "object" || Array.isArray(body))
    throw usage("请求体应为对象");
  for (const key of Object.keys(body))
    if (!keys.includes(key)) throw usage(`${key}: 是未知字段`);
  return body;
}

/** 撤销、沉淀时写的原因：必填、有上限。纯函数。 */
export function changeWhy(value: unknown, flag = "--why"): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw usage(`${flag}: 原因必填`);
  if (Array.from(text).length > CHANGE_WHY_MAX)
    throw usage(`${flag}: 原因不能超过 ${CHANGE_WHY_MAX} 字`);
  return text;
}

function manageable(
  db: DatabaseSync,
  reference: unknown,
  leader: string | undefined,
): Row {
  const row = requireRow(db, parseDecisionRef(reference));
  const problem = manageVerdict(leader, row.owner, row.id);
  if (problem) throw new Problem(403, problem, "leader_scope");
  return row;
}

const conflict = (message: string, next?: string) =>
  new Problem(409, message, "conflict", undefined, next);

function record(
  db: DatabaseSync,
  id: number,
  kind: string,
  actor: string,
  why: string,
  detail: string | null,
  now: number,
) {
  db.prepare(
    "INSERT INTO decision_changes(decision_id,kind,actor,why,detail,created_at) VALUES(?,?,?,?,?,?)",
  ).run(id, kind, actor, why, detail, now);
}

/** 补挂节点：decision tag dN --node oN [--node oM]。 */
export function tagDecision(
  db: DatabaseSync,
  reference: unknown,
  body: unknown,
  leader?: string,
): Decision {
  const input = bodyOf(body, ["node"]);
  const addresses = nodeAddresses(input.node);
  if (!addresses.length) throw usage("--node: 挂到哪个节点，如 o3");
  return atomically(db, () => {
    const row = manageable(db, reference, leader);
    linkNodes(db, row.id, addresses);
    return getDecision(db, row.id);
  });
}

/** 标或取消「原则」：decision mark dN --principle | --normal。 */
export function markDecision(
  db: DatabaseSync,
  reference: unknown,
  body: unknown,
  leader?: string,
): Decision {
  const input = bodyOf(body, ["principle"]);
  if (typeof input.principle !== "boolean")
    throw usage("--principle: 标原则给 --principle，取消给 --normal");
  return atomically(db, () => {
    const row = manageable(db, reference, leader);
    db.prepare("UPDATE decisions SET principle=? WHERE id=?").run(
      input.principle ? 1 : 0,
      row.id,
    );
    return getDecision(db, row.id);
  });
}

/**
 * 沉淀成要点：--point kN 指向已有的要点，或 new_point 在节点上新建一条（为什么缺省用决定的原因，
 * 谁定的缺省「拍板人 月-日」）。要点的权限照旧（leader 链；根只有用户）。
 */
export function settleDecision(
  db: DatabaseSync,
  reference: unknown,
  body: unknown,
  actor: string,
  leader?: string,
  now = Date.now(),
): { decision: Decision; point: string } {
  const input = bodyOf(body, ["point", "new_point", "why", "by"]);
  const point = typeof input.point === "string" ? input.point.trim() : "";
  const fresh =
    input.new_point && typeof input.new_point === "object"
      ? (input.new_point as Record<string, unknown>)
      : null;
  if (!!point === !!fresh)
    throw usage(
      "沉淀到哪：已有的要点给 --point kN，新建给 --new-point 节点 要点",
    );
  return atomically(db, () => {
    const row = manageable(db, reference, leader);
    const problem = settleVerdict(row);
    if (problem)
      throw conflict(problem, `atrium decision ls --all --node 节点`);
    const ref = decisionRef(row.id);
    let target = point;
    if (fresh) {
      const why =
        typeof input.why === "string" && input.why.trim()
          ? input.why.trim()
          : row.why;
      if (Array.from(why).length > POINT_LIMITS.why)
        throw usage(
          `--why: 决定的原因 ${Array.from(why).length} 字，超过要点上限 ${POINT_LIMITS.why} 字；用 --why 写一句短的`,
        );
      const by =
        typeof input.by === "string" && input.by.trim()
          ? input.by.trim()
          : `${row.decided_by === "secretary" ? "秘书" : row.decided_by} ${row.decided_on.slice(5)} 定`;
      target = addPoint(
        db,
        String(fresh.node ?? ""),
        { text: fresh.text, why, by },
        actor,
      ).ref;
    }
    addPointSource(db, target, ref, actor);
    db.prepare(
      "UPDATE decisions SET settled_point=?,settled_at=? WHERE id=?",
    ).run(Number(target.slice(1)), now, row.id);
    record(db, row.id, "settle", actor, `沉淀到 ${target}`, target, now);
    return { decision: getDecision(db, row.id), point: target };
  });
}

/** 撤销误标的推翻：恢复为有效，记一笔谁撤销的、为什么、原先被哪条推翻。 */
export function unsupersedeDecision(
  db: DatabaseSync,
  reference: unknown,
  body: unknown,
  actor: string,
  leader?: string,
  now = Date.now(),
): Decision {
  const input = bodyOf(body, ["why"]);
  const why = changeWhy(input.why);
  return atomically(db, () => {
    const row = manageable(db, reference, leader);
    const problem = unsupersedeVerdict(row);
    if (problem) throw conflict(problem);
    db.prepare(
      "UPDATE decisions SET superseded_by=NULL,superseded_at=NULL WHERE id=?",
    ).run(row.id);
    record(
      db,
      row.id,
      "unsupersede",
      actor,
      why,
      decisionRef(row.superseded_by!),
      now,
    );
    return getDecision(db, row.id);
  });
}
