import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import {
  nodeByAddress,
  nodes,
  ref as nodeRef,
  transaction,
  type NodeRow,
} from "../org/model.ts";
import { hasOrg } from "../org/task-node.ts";
import { objectOf, onlyKeys } from "../tasks/ledger-validate.ts";
import {
  allGoals,
  dependencies,
  goalRef,
  parseGoalRef,
  requireGoal,
  usage,
  type GoalRow,
} from "./model.ts";
import {
  DEPTH_MAX,
  STATUS_LABEL,
  canChange,
  canCreate,
  depthOf,
  isWithin,
  prerequisiteCycle,
  subtreeHeight,
  transition,
  unmetPrerequisites,
  type GoalAction,
  type Permission,
} from "./rules.ts";
import { goalView, hasTaskGoals } from "./read.ts";

const RESULT_MAX = 200;
const CRITERION_MAX = 500;
const CRITERIA_MAX = 20;
const NOTE_MAX = 500;

function resultOf(value: unknown) {
  if (typeof value !== "string" || !value.trim())
    throw usage("结果: 不能为空，用一句话写要达到的状态");
  const text = value.replace(/\s+/g, " ").trim();
  if (Array.from(text).length > RESULT_MAX)
    throw usage(`结果: 不能超过 ${RESULT_MAX} 字，一句话写清要达到的状态`);
  return text;
}
function criteriaOf(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list) || list.some((item) => typeof item !== "string"))
    throw usage("--criteria: 每条验收标准应为文本");
  const items = (list as string[]).map((item) => item.trim()).filter(Boolean);
  if (items.length > CRITERIA_MAX)
    throw usage(`--criteria: 最多 ${CRITERIA_MAX} 条`);
  for (const item of items)
    if (Array.from(item).length > CRITERION_MAX)
      throw usage(`--criteria: 每条不能超过 ${CRITERION_MAX} 字`);
  if (new Set(items).size !== items.length)
    throw usage("--criteria: 验收标准不能重复");
  return items;
}
function dueOf(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const match =
    typeof value === "string"
      ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
      : null;
  const date = match ? new Date(`${match[0]}T00:00:00Z`) : null;
  if (!match || !date || date.toISOString().slice(0, 10) !== match[0])
    throw usage("--due: 目标日期应为 2026-10-01 这样的日期");
  return match[0];
}
function noteOf(value: unknown, field = "--note"): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw usage(`${field}: 应为文本`);
  const text = value.trim();
  if (Array.from(text).length > NOTE_MAX)
    throw usage(`${field}: 不能超过 ${NOTE_MAX} 字`);
  return text || null;
}
function afterOf(value: unknown): number[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value !== "string")
    throw usage("--after: 用逗号分隔目标短号，如 g1,g2");
  const ids = value.split(",").map((part) => parseGoalRef(part, "--after"));
  if (new Set(ids).size !== ids.length)
    throw usage("--after: 前置里程碑不能重复");
  return ids;
}
/** 负责部门：组织节点短号或路径，须存在且未归档。 */
function nodeOf(db: DatabaseSync, value: unknown): NodeRow {
  if (!hasOrg(db)) throw usage("--node: 还没有组织树", "atrium org import");
  if (typeof value !== "string" || !value.trim())
    throw usage("--node: 应为组织节点，如 o2 或 atrium/runtime");
  let node: NodeRow;
  try {
    node = nodeByAddress(db, value.trim());
  } catch (error) {
    if (error instanceof Problem)
      throw new Problem(
        400,
        `--node: ${error.message}`,
        "usage",
        error.candidates,
        "atrium org tree",
      );
    throw error;
  }
  if (node.archived_at !== null)
    throw usage(`--node: 节点 ${nodeRef(node.id)} ${node.name} 已归档`);
  return node;
}
function rootNode(db: DatabaseSync): NodeRow {
  const root = hasOrg(db)
    ? nodes(db).find((n) => n.parent_id === null && n.archived_at === null)
    : undefined;
  if (!root)
    throw usage(
      "--node: 还没有组织树，建顶层目标要先有组织根节点",
      "atrium org import",
    );
  return root;
}
function allowed(permission: Permission) {
  if (!permission.ok) throw new Problem(403, permission.reason, "conflict");
}
/** 前置整组替换：各自存在、不是自己、不成环。 */
function setAfter(db: DatabaseSync, id: number, after: number[]) {
  for (const other of after) {
    if (other === id) throw usage("--after: 不能把自己设为前置");
    requireGoal(db, other, "--after");
  }
  const cycle = prerequisiteCycle(dependencies(db), id, after);
  if (cycle)
    throw usage(`--after: 前置成环：${cycle.map(goalRef).join(" → ")}`);
  db.prepare("DELETE FROM goal_dependencies WHERE goal_id=?").run(id);
  const insert = db.prepare(
    "INSERT INTO goal_dependencies(goal_id,after_id) VALUES(?,?)",
  );
  for (const other of after) insert.run(id, other);
}
function checkDepth(goals: GoalRow[], parent: GoalRow, height = 1) {
  if (depthOf(goals, parent.id) + height > DEPTH_MAX)
    throw usage(`--parent: 目标树最多 ${DEPTH_MAX} 层`);
}

export function addGoal(
  db: DatabaseSync,
  body: unknown,
  actor: string,
  now = Date.now(),
) {
  const input = objectOf(body);
  onlyKeys(input, [
    "result",
    "parent",
    "node",
    "criteria",
    "after",
    "due",
    "status",
  ]);
  const result = resultOf(input.result),
    criteria = criteriaOf(input.criteria),
    due = dueOf(input.due),
    after = afterOf(input.after);
  const status = input.status ?? "planned";
  if (status !== "planned" && status !== "active")
    throw usage("--status: 新建时只能是 planned（规划中）或 active（进行中）");
  return transaction(db, () => {
    const goals = allGoals(db);
    const parent =
      input.parent === undefined || input.parent === null || input.parent === ""
        ? null
        : requireGoal(db, parseGoalRef(input.parent, "--parent"), "--parent");
    if (parent?.status === "dropped")
      throw usage(
        `--parent: ${goalRef(parent.id)} 已放弃，先改回再往下拆`,
        `atrium goal edit ${goalRef(parent.id)} --status active`,
      );
    const node =
      input.node === undefined || input.node === null || input.node === ""
        ? parent
          ? { id: parent.node_id }
          : rootNode(db)
        : nodeOf(db, input.node);
    allowed(canCreate(nodes(db), parent, node.id, actor));
    if (parent) checkDepth(goals, parent);
    const { lastInsertRowid } = db
      .prepare(
        "INSERT INTO goals(parent_id,result,criteria,status,node_id,due,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        parent?.id ?? null,
        result,
        JSON.stringify(criteria),
        status,
        node.id,
        due,
        actor,
        now,
        now,
      );
    const id = Number(lastInsertRowid);
    setAfter(db, id, after);
    return goalView(db, requireGoal(db, id));
  });
}

export function editGoal(
  db: DatabaseSync,
  reference: unknown,
  body: unknown,
  actor: string,
  now = Date.now(),
) {
  const id = parseGoalRef(reference, "目标");
  const input = objectOf(body);
  const keys = [
    "result",
    "criteria",
    "node",
    "parent",
    "after",
    "due",
    "status",
    "note",
  ];
  onlyKeys(input, keys);
  if (!Object.keys(input).length)
    throw usage(
      "至少改一项：--result、--criteria、--node、--parent、--after、--due、--status、--note",
    );
  const fields: Record<string, string | number | null> = {};
  if ("result" in input) fields.result = resultOf(input.result);
  if ("criteria" in input)
    fields.criteria = JSON.stringify(criteriaOf(input.criteria));
  if ("due" in input) fields.due = dueOf(input.due);
  if ("note" in input) fields.note = noteOf(input.note);
  const after = "after" in input ? afterOf(input.after) : undefined;
  return transaction(db, () => {
    const current = requireGoal(db, id);
    const org = nodes(db);
    allowed(canChange(org, current, actor));
    if ("status" in input) {
      const to = input.status;
      if (to !== "planned" && to !== "active" && to !== "blocked")
        throw usage(
          "--status: 只能是 planned（规划中）、active（进行中）或 blocked（受阻）；达成用 goal done，放弃用 goal drop",
        );
      const verdict = transition(current.status, { kind: "set", to });
      if (!verdict.ok)
        throw new Problem(409, `${goalRef(id)} ${verdict.reason}`, "conflict");
      fields.status = verdict.to;
      if (!("note" in input)) fields.note = null;
    }
    if ("node" in input) {
      const node = nodeOf(db, input.node);
      allowed(canChange(org, { ...current, node_id: node.id }, actor));
      fields.node_id = node.id;
    }
    if ("parent" in input) {
      if (current.parent_id === null)
        throw usage("--parent: 顶层目标不能挂到别的目标下");
      const parent = requireGoal(
        db,
        parseGoalRef(input.parent, "--parent"),
        "--parent",
      );
      const goals = allGoals(db);
      if (isWithin(goals, parent.id, id))
        throw usage(
          `--parent: ${goalRef(parent.id)} 是 ${goalRef(id)} 自己或它的下层`,
        );
      if (parent.status === "dropped")
        throw usage(`--parent: ${goalRef(parent.id)} 已放弃`);
      allowed(
        canCreate(
          org,
          parent,
          (fields.node_id as number) ?? current.node_id,
          actor,
        ),
      );
      checkDepth(goals, parent, subtreeHeight(goals, id));
      fields.parent_id = parent.id;
    }
    const changed = Object.entries(fields).filter(
      ([key, value]) => current[key as keyof GoalRow] !== value,
    );
    if (after !== undefined) setAfter(db, id, after);
    if (changed.length || after !== undefined)
      db.prepare(
        `UPDATE goals SET ${changed.map(([key]) => `${key}=?,`).join("")}updated_by=?,updated_at=? WHERE id=?`,
      ).run(...changed.map(([, value]) => value), actor, now, id);
    return {
      ...goalView(db, requireGoal(db, id)),
      changed: [
        ...changed.map(([key]) =>
          key === "node_id" ? "node" : key === "parent_id" ? "parent" : key,
        ),
        ...(after === undefined ? [] : ["after"]),
      ],
    };
  });
}

/** 达成与放弃：权限同编辑；达成要求前置都已达成，放弃要写原因、下层与挂着的任务先收尾。 */
export function settleGoal(
  db: DatabaseSync,
  reference: unknown,
  action: Extract<GoalAction, { kind: "done" | "drop" }>,
  body: unknown,
  actor: string,
  now = Date.now(),
) {
  const id = parseGoalRef(reference, "目标");
  const input = objectOf(body ?? {});
  onlyKeys(input, ["note"]);
  const note = noteOf(
    input.note,
    action.kind === "drop" ? "--reason" : "--note",
  );
  if (action.kind === "drop" && !note) throw usage("--reason: 放弃要写原因");
  return transaction(db, () => {
    const current = requireGoal(db, id);
    allowed(canChange(nodes(db), current, actor));
    const verdict = transition(current.status, action);
    if (!verdict.ok)
      throw new Problem(409, `${goalRef(id)} ${verdict.reason}`, "conflict");
    if (action.kind === "done") {
      const prerequisites = db
        .prepare(
          "SELECT g.id,g.status FROM goal_dependencies d JOIN goals g ON g.id=d.after_id WHERE d.goal_id=? ORDER BY g.id",
        )
        .all(id) as { id: number; status: GoalRow["status"] }[];
      const unmet = unmetPrerequisites(prerequisites);
      if (unmet.length)
        throw new Problem(
          409,
          `${goalRef(id)} 的前置还没达成：${unmet.map((p) => `${goalRef(p.id)}（${STATUS_LABEL[p.status]}）`).join("、")}`,
          "conflict",
          undefined,
          `atrium goal show ${goalRef(id)}`,
        );
    } else {
      const open = db
        .prepare(
          "SELECT id FROM goals WHERE parent_id=? AND status NOT IN ('achieved','dropped') ORDER BY id LIMIT 20",
        )
        .all(id) as { id: number }[];
      if (open.length)
        throw new Problem(
          409,
          `${goalRef(id)} 下还有没收尾的里程碑：${open.map((g) => goalRef(g.id)).join("、")}；先达成或放弃它们`,
          "conflict",
          undefined,
          `atrium goal tree ${goalRef(id)}`,
        );
      const tasks = !hasTaskGoals(db)
        ? []
        : (db
            .prepare(
              "SELECT id FROM tasks WHERE goal_id=? AND status IN ('todo','running','blocked') ORDER BY id LIMIT 20",
            )
            .all(id) as { id: number }[]);
      if (tasks.length)
        throw new Problem(
          409,
          `${goalRef(id)} 上还挂着没结的任务：${tasks.map((t) => `t${t.id}`).join("、")}；先收尾或改挂别的里程碑`,
          "conflict",
          undefined,
          `atrium goal show ${goalRef(id)}`,
        );
    }
    db.prepare(
      "UPDATE goals SET status=?,note=?,updated_by=?,updated_at=? WHERE id=?",
    ).run(verdict.to, note, actor, now, id);
    return goalView(db, requireGoal(db, id));
  });
}
