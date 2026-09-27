import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { nodes, transaction } from "../org/model.ts";
import {
  addEvent,
  all,
  parseTaskRef,
  requireRow,
  taskRef,
} from "../tasks/ledger-model.ts";
import { objectOf, onlyKeys } from "../tasks/ledger-validate.ts";
import { applyTransition } from "../tasks/ledger-transition.ts";
import {
  allGoals,
  goalRef,
  parseGoalRef,
  requireGoal,
  usage,
} from "./model.ts";
import {
  DEPTH_MAX,
  STATUS_LABEL,
  adoptBlocker,
  adoptedStatus,
  canCreate,
  depthOf,
} from "./rules.ts";
import { hasTaskGoals } from "./read.ts";
import { nodeByAddress, ref as nodeRef } from "../org/model.ts";

const CHILDREN_MAX = 500;

export type AdoptPlan = {
  preview: boolean;
  task: string;
  goal: {
    ref: string | null;
    result: string;
    parent: string;
    node: string;
    status: string;
    status_label: string;
  };
  attach: string[];
  keep: { task: string; goal: string }[];
  /** 父任务的处理：cancel 标取消，keep 已是终态保持原状。 */
  parent_task: "cancel" | "keep";
};

/**
 * 只起归类作用的父任务迁为里程碑（#313）：父任务标题作里程碑结果，挂到 --parent 下；
 * 直接子任务挂上新里程碑并上移到父任务的上一层，父任务标取消并也挂上新里程碑留痕。
 * 默认只预览；apply 在一个事务里写，并给涉及的任务各记一条 goal_adopt 事件。
 */
export function adoptTask(
  db: DatabaseSync,
  body: unknown,
  actor: string,
  now = Date.now(),
): AdoptPlan {
  const input = objectOf(body);
  onlyKeys(input, ["task", "parent", "node", "apply"]);
  const apply = input.apply === true;
  if (!hasTaskGoals(db)) throw usage("任务账本还没准备好");
  const run = () => {
    const task = requireRow(db, parseTaskRef(input.task, "task"));
    if (input.parent === undefined || input.parent === "")
      throw usage(
        "--parent: 要指定挂到哪个目标或里程碑下，如 g1",
        "atrium goal tree",
      );
    const parent = requireGoal(
      db,
      parseGoalRef(input.parent, "--parent"),
      "--parent",
    );
    if (parent.status === "dropped")
      throw usage(`--parent: ${goalRef(parent.id)} 已放弃`);
    const children = all<{
      id: number;
      status: string;
      goal_id: number | null;
    }>(
      db,
      "SELECT id,status,goal_id FROM tasks WHERE parent_id=? ORDER BY id LIMIT ?",
      task.id,
      CHILDREN_MAX + 1,
    );
    if (children.length > CHILDREN_MAX)
      throw usage(
        `${taskRef(task.id)} 的子任务超过 ${CHILDREN_MAX} 个，先手工拆开`,
      );
    const blocker = adoptBlocker({ ...task, children: children.length });
    if (blocker)
      throw new Problem(
        409,
        `${taskRef(task.id)} 不能迁为里程碑：${blocker}`,
        "conflict",
        undefined,
        `atrium task show ${taskRef(task.id)}`,
      );
    let nodeId = task.node_id ?? parent.node_id;
    if (typeof input.node === "string" && input.node.trim()) {
      try {
        nodeId = nodeByAddress(db, input.node.trim()).id;
      } catch (error) {
        if (error instanceof Problem)
          throw usage(`--node: ${error.message}`, "atrium org tree");
        throw error;
      }
    }
    const permission = canCreate(nodes(db), parent, nodeId, actor);
    if (!permission.ok) throw new Problem(403, permission.reason, "conflict");
    if (depthOf(allGoals(db), parent.id) + 1 > DEPTH_MAX)
      throw usage(`--parent: 目标树最多 ${DEPTH_MAX} 层`);
    const status = adoptedStatus(
      task.status,
      children.map((c) => c.status),
    );
    const attach = children.filter((c) => c.goal_id === null);
    const keep = children.filter((c) => c.goal_id !== null);
    const cancel = !["done", "cancelled"].includes(task.status);
    const plan: AdoptPlan = {
      preview: !apply,
      task: taskRef(task.id),
      goal: {
        ref: null,
        result: task.title,
        parent: goalRef(parent.id),
        node: nodeRef(nodeId),
        status,
        status_label: STATUS_LABEL[status],
      },
      attach: attach.map((c) => taskRef(c.id)),
      keep: keep.map((c) => ({
        task: taskRef(c.id),
        goal: goalRef(c.goal_id!),
      })),
      parent_task: cancel ? "cancel" : "keep",
    };
    if (!apply) return plan;
    const { lastInsertRowid } = db
      .prepare(
        "INSERT INTO goals(parent_id,result,criteria,status,note,node_id,updated_by,created_at,updated_at) VALUES(?,?,'[]',?,?,?,?,?,?)",
      )
      .run(
        parent.id,
        task.title,
        status,
        `由父任务 ${taskRef(task.id)} 迁来`,
        nodeId,
        actor,
        now,
        now,
      );
    const goal = Number(lastInsertRowid);
    const detail = { goal: goalRef(goal), from: taskRef(task.id) };
    const move = db.prepare(
      "UPDATE tasks SET parent_id=?,goal_id=COALESCE(goal_id,?),updated_at=? WHERE id=?",
    );
    for (const child of children) {
      move.run(task.parent_id, goal, now, child.id);
      addEvent(db, child.id, now, "goal_adopt", detail);
    }
    db.prepare("UPDATE tasks SET goal_id=?,updated_at=? WHERE id=?").run(
      goal,
      now,
      task.id,
    );
    addEvent(db, task.id, now, "goal_adopt", detail);
    if (cancel)
      applyTransition(
        db,
        requireRow(db, task.id),
        { kind: "cancel" },
        now,
        {},
        detail,
      );
    return { ...plan, goal: { ...plan.goal, ref: goalRef(goal) } };
  };
  return apply ? transaction(db, run) : run();
}
