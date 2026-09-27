import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import {
  addEvent,
  atomically,
  parseTaskRef,
  requireRow,
  taskRef,
  view,
  type Task,
  type TaskRow,
  usage,
} from "./ledger-model.ts";
import {
  objectOf,
  onlyKeys,
  optionalText,
  ownerOf,
  parentOf,
  repoOf,
  statusOf,
  title,
} from "./ledger-validate.ts";
import { applyTransition } from "./ledger-transition.ts";
import { setConditions } from "./schedule-ledger.ts";
import { noteView } from "./notes.ts";
import {
  deliverOf,
  issueOf,
  validateDeliver,
  type Deliver,
} from "./deliver.ts";
import { matchRole, originNode } from "../org/task-node.ts";
import { partForTask } from "../org/task-part.ts";
import {
  concernRows,
  concernsFor,
  concernsOf,
  textHints,
  writeConcerns,
} from "./concerns.ts";
import { ref as nodeRef } from "../org/model.ts";

/** role → 节点；写成节点地址却解析不到时报错，旧岗位名对不上节点就只存 role。 */
const roleNode = (
  db: DatabaseSync,
  role: string | null,
  repo: string | null,
) => (role ? (matchRole(db, role, repo, true).node?.id ?? null) : null);
const fromNode = (db: DatabaseSync, value: unknown) => {
  const text = optionalText(value, "from", 200);
  return text ? originNode(db, text).id : null;
};

/** part 与旧写法 goal 二选一；goal 的 gN 按迁移映射到负责节点。 */
function partOf(db: DatabaseSync, input: Record<string, unknown>) {
  if ("part" in input && "goal" in input)
    throw usage("part: 与 goal 只能给一个；goal 已改为归属部分，用 part");
  return "goal" in input
    ? partForTask(db, input.goal, "goal")
    : partForTask(db, input.part);
}

export type NewTask = {
  title: string;
  parent?: string | number | null;
  role?: string | null;
  repo?: string | null;
  brief_path?: string | null;
  owner?: string | null;
  deliver?: Deliver;
  issue?: number;
  after?: string;
  after_pr?: string;
  auto?: boolean;
  /** 投任务的节点（关注点往模块投时）。 */
  from?: string | null;
  /** 归属哪一部分（组织节点）。 */
  part?: string | null;
  /** 旧写法：gN 按目标树迁移映射到该目标的负责节点，等同 part。 */
  goal?: string | null;
  /** 请哪些专员：关注点节点，逗号分隔。 */
  concern?: string | null;
};

/** 任务读回时带上请的专员，改请专员或建任务时再带上按标题详述给的提示。 */
function withConcerns(db: DatabaseSync, task: TaskRow, hints: boolean) {
  const concerns = concernsOf(db, task.id);
  const concern_hints = hints ? textHints(db, task) : [];
  return {
    ...(concerns.length ? { concerns } : {}),
    ...(concern_hints.length ? { concern_hints } : {}),
  };
}

export function createTask(
  db: DatabaseSync,
  body: unknown,
  now = Date.now(),
): Task {
  const input = objectOf(body);
  onlyKeys(input, [
    "title",
    "parent",
    "role",
    "repo",
    "brief_path",
    "owner",
    "deliver",
    "issue",
    "after",
    "after_pr",
    "auto",
    "from",
    "part",
    "goal",
    "concern",
  ]);
  const deliver = input.deliver === undefined ? "pr" : deliverOf(input.deliver);
  const issue = issueOf(input.issue);
  validateDeliver(deliver, issue);
  const values = {
    owner:
      input.owner === undefined || input.owner === null || input.owner === ""
        ? null
        : ownerOf(input.owner),
    title: title(input.title),
    role: optionalText(input.role, "role", 200),
    repo: repoOf(input.repo),
    brief_path: optionalText(input.brief_path, "brief_path"),
  };
  return atomically(db, () => {
    const parent = parentOf(db, input.parent);
    const node = roleNode(db, values.role, values.repo);
    const origin = fromNode(db, input.from);
    const part = partOf(db, input);
    const concerns = concernsFor(db, input.concern);
    const { lastInsertRowid } = db
      .prepare(
        "INSERT INTO tasks(parent_id,title,brief_path,role,repo,owner,deliver,issue,node_id,origin_node_id,part_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'todo',?,?)",
      )
      .run(
        parent,
        values.title,
        values.brief_path,
        values.role,
        values.repo,
        values.owner,
        deliver,
        issue,
        node,
        origin,
        part,
        now,
        now,
      );
    const id = Number(lastInsertRowid);
    setConditions(db, id, input, now);
    writeConcerns(db, id, concerns);
    addEvent(db, id, now, "created", {
      title: values.title,
      ...(parent ? { parent: taskRef(parent) } : {}),
      ...(node ? { node: `o${node}` } : {}),
      ...(origin ? { from: `o${origin}` } : {}),
      ...(part ? { part: `o${part}` } : {}),
      ...(concerns.length ? { concerns: concerns.map(nodeRef) } : {}),
    });
    const task = requireRow(db, id);
    return {
      ...view(task),
      ...noteView(db, id, task.status),
      ...withConcerns(db, task, true),
    };
  });
}

/** 人工修正：title / brief_path / role / status；status 经状态机的 manual_set。 */
export function updateTask(
  db: DatabaseSync,
  reference: unknown,
  body: unknown,
  now = Date.now(),
): Task {
  const id = parseTaskRef(reference);
  const input = objectOf(body);
  onlyKeys(input, [
    "title",
    "brief_path",
    "role",
    "status",
    "deliver",
    "issue",
    "after",
    "after_pr",
    "auto",
    "pr_url",
    "from",
    "part",
    "goal",
    "concern",
  ]);
  if (!Object.keys(input).length)
    throw usage(
      "至少修改一项：title、brief_path、role、from、part、concern、status、deliver、issue、after、after_pr、auto、pr_url",
    );
  const fields: Record<string, string | number | null> = {};
  if ("title" in input) fields.title = title(input.title);
  if ("brief_path" in input)
    fields.brief_path = optionalText(input.brief_path, "brief_path");
  if ("role" in input) fields.role = optionalText(input.role, "role", 200);
  if ("deliver" in input) fields.deliver = deliverOf(input.deliver);
  if ("issue" in input) fields.issue = issueOf(input.issue);
  if ("pr_url" in input) {
    if (
      typeof input.pr_url !== "string" ||
      !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/.test(
        input.pr_url,
      )
    )
      throw usage("pr_url: 应为 https://github.com/owner/repo/pull/N");
    fields.pr_url = input.pr_url;
  }
  const target = "status" in input ? statusOf(input.status) : undefined;
  return atomically(db, () => {
    const current = requireRow(db, id);
    if ("role" in fields)
      fields.node_id = roleNode(db, fields.role as string | null, current.repo);
    if ("from" in input) fields.origin_node_id = fromNode(db, input.from);
    if ("part" in input || "goal" in input) fields.part_id = partOf(db, input);
    if (fields.pr_url !== undefined && current.status === "running")
      throw new Problem(409, "执行中不能人工补登 PR", "conflict");
    const concerns =
      "concern" in input ? concernsFor(db, input.concern) : undefined;
    if (concerns && current.status === "running")
      throw new Problem(
        409,
        "执行中不能改请的专员：提示词已经发出；等它结束再改，下一轮生效",
        "conflict",
        undefined,
        `atrium task wait ${taskRef(id)}`,
      );
    setConditions(db, id, input, now);
    if (concerns) {
      const before = concernRows(db, id).map((row) => nodeRef(row.node_id));
      writeConcerns(db, id, concerns);
      const after = concerns.map(nodeRef);
      if (before.join(",") !== after.join(","))
        addEvent(db, id, now, "concerns", { from: before, to: after });
    }
    if (
      current.status === "running" &&
      ((fields.deliver !== undefined && fields.deliver !== current.deliver) ||
        (fields.issue !== undefined && fields.issue !== current.issue))
    )
      throw new Problem(409, "执行中不能修改交付物类型或 issue 号", "conflict");
    validateDeliver(
      (fields.deliver ?? current.deliver) as Deliver,
      (fields.issue === undefined ? current.issue : fields.issue) as
        number | null,
    );
    const changed = Object.fromEntries(
      Object.entries(fields).filter(
        ([key, value]) => current[key as keyof TaskRow] !== value,
      ),
    );
    if (changed.pr_url) changed.ci = "pending";
    if (Object.keys(changed).length) {
      db.prepare(
        `UPDATE tasks SET ${Object.keys(changed)
          .map((key) => `${key}=?`)
          .join(",")},updated_at=? WHERE id=?`,
      ).run(...Object.values(changed), now, id);
      addEvent(db, id, now, "edited", changed);
    }
    if (target !== undefined)
      applyTransition(db, current, { kind: "manual_set", to: target }, now);
    const task = requireRow(db, id);
    return {
      ...view(task),
      ...noteView(db, id, task.status),
      ...withConcerns(db, task, concerns !== undefined || "title" in input),
    };
  });
}
