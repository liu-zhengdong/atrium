import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import {
  addEvent,
  atomically,
  one,
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
import { originNode } from "../org/task-node.ts";
import { partForTask } from "../org/task-part.ts";
import { parsePriority } from "./priority.ts";
import { getJobRole } from "./job-roles.ts";
import { ref as nodeRef } from "../org/model.ts";
import { briefText, readBriefFile } from "./brief.ts";
import { parseSecretNames } from "../secrets/model.ts";
import {
  checkTaskSecrets,
  taskSecretNames,
  writeTaskSecrets,
} from "../secrets/store.ts";
import { syncTotals } from "./rollup-ledger.ts";
import { avoidHostsOf } from "../hosts/state.ts";

/** brief 给内容（brief_path 记来源）；只给 brief_path 时按路径读入，兼容旧调用方。 */
function briefOf(input: Record<string, unknown>, repo: string | null) {
  const brief_path = optionalText(input.brief_path, "brief_path");
  if (input.brief !== undefined)
    return { brief: briefText(input.brief), brief_path };
  return {
    brief: brief_path ? readBriefFile(brief_path, repo) : null,
    brief_path,
  };
}

/** `avoid_host`：主机短号列表存成 JSON；没给为 undefined，给空为 null。 */
function avoidOf(input: Record<string, unknown>) {
  if (!("avoid_host" in input)) return undefined;
  const hosts = avoidHostsOf(input.avoid_host);
  return hosts.length ? JSON.stringify(hosts) : null;
}

const fromNode = (db: DatabaseSync, value: unknown) => {
  const text = optionalText(value, "from", 200);
  return text ? originNode(db, text).id : null;
};

const partOf = (db: DatabaseSync, input: Record<string, unknown>) =>
  partForTask(db, input.part);

export type NewTask = {
  title: string;
  parent?: string | number | null;
  by?: string | null;
  repo?: string | null;
  /** 任务详述内容（#355）。 */
  brief?: string | null;
  /** 详述来源文件；只给它时建任务当下读入内容。 */
  brief_path?: string | null;
  owner?: string | null;
  deliver?: Deliver;
  issue?: number;
  after?: string;
  after_pr?: string;
  auto?: boolean;
  /** 紧急 / 修复 / 普通 / 闲时；不写按归属部分：管方面的为闲时。 */
  priority?: string;
  /** 派活避开的主机（hN，逗号分隔）。 */
  avoid_host?: string;
  /** 投任务的节点（关注点往模块投时）。 */
  from?: string | null;
  /** 归属哪一部分（组织节点）。 */
  part?: string | null;
  /** 要用的凭据名称（t194），逗号分隔；派活时按名称注入执行者环境。 */
  secret?: string | null;
};

/** 任务读回时带上凭据名称。 */
function extrasOf(db: DatabaseSync, task: TaskRow) {
  const secrets = taskSecretNames(db, task.id);
  return secrets.length ? { secrets } : {};
}

/** `by`：专员名称或短号；null 与空串表示不指定。 */
function byOf(value: unknown) {
  if (value !== undefined && value !== null && typeof value !== "string")
    throw usage("by: 应为专员名称或短号");
  return value || null;
}

/** 修复任务按标题去重（巡检直接建修复任务）：同一部分已有同标题、没结束的修复任务就拒绝。 */
function duplicateFix(db: DatabaseSync, part: number, title: string) {
  const same = one<{ id: number }>(
    db,
    "SELECT id FROM tasks WHERE part_id=? AND title=? AND prio='fix' AND status NOT IN ('done','failed','cancelled') LIMIT 1",
    part,
    title,
  );
  if (same)
    throw new Problem(
      409,
      `${nodeRef(part)} 已有同标题的修复任务 t${same.id} 还没结束`,
      "conflict",
      undefined,
      `atrium task note t${same.id} 补充`,
    );
}

export function createTask(
  db: DatabaseSync,
  body: unknown,
  now = Date.now(),
  /** 建任务的 leader（aN）：记进 created 事件，全景据此显示「谁派的」。 */
  by?: string,
  /** 运行时替父任务建的帮手（审阅）：不让父任务变成总任务（t190）。 */
  internal: { helper?: boolean } = {},
): Task {
  const input = objectOf(body);
  onlyKeys(input, [
    "title",
    "parent",
    "by",
    "repo",
    "brief",
    "brief_path",
    "owner",
    "deliver",
    "issue",
    "after",
    "after_pr",
    "auto",
    "avoid_host",
    "priority",
    "from",
    "part",
    "secret",
  ]);
  const by_ = byOf(input.by);
  const avoid = avoidOf(input);
  const priority =
    input.priority === undefined ? undefined : parsePriority(input.priority);
  const deliver = input.deliver === undefined ? "pr" : deliverOf(input.deliver);
  const issue = issueOf(input.issue);
  validateDeliver(deliver, issue);
  const repo = repoOf(input.repo);
  const secrets = parseSecretNames(input.secret);
  const values = {
    owner:
      input.owner === undefined || input.owner === null || input.owner === ""
        ? null
        : ownerOf(input.owner),
    title: title(input.title),
    repo,
    ...briefOf(input, repo),
  };
  return atomically(db, () => {
    const parent = parentOf(db, input.parent);
    const job = by_ ? getJobRole(db, by_).id : null;
    const origin = fromNode(db, input.from);
    const part = partOf(db, input);
    checkTaskSecrets(db, part, secrets);
    const level = priority ?? "normal";
    if (level === "fix" && part !== null) duplicateFix(db, part, values.title);
    const { lastInsertRowid } = db
      .prepare(
        "INSERT INTO tasks(parent_id,helper,title,brief,brief_path,repo,owner,deliver,issue,origin_node_id,part_id,job_id,prio,avoid_hosts,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'todo',?,?)",
      )
      .run(
        parent,
        internal.helper && parent ? 1 : 0,
        values.title,
        values.brief,
        values.brief_path,
        values.repo,
        values.owner,
        deliver,
        issue,
        origin,
        part,
        job,
        level,
        avoid ?? null,
        now,
        now,
      );
    const id = Number(lastInsertRowid);
    setConditions(db, id, input, now);
    writeTaskSecrets(db, id, secrets);
    addEvent(db, id, now, "created", {
      title: values.title,
      ...(parent ? { parent: taskRef(parent) } : {}),
      ...(origin ? { from: `o${origin}` } : {}),
      ...(part ? { part: `o${part}` } : {}),
      ...(job ? { job: `r${job}` } : {}),
      ...(level !== "normal" ? { priority: level } : {}),
      ...(secrets.length ? { secrets } : {}),
      ...(by ? { by } : {}),
    });
    // 父任务有了子任务就是总任务（t190）：撤出排队，已结束的按汇总改回待办。
    if (parent && !internal.helper) syncTotals(db, id, now);
    const task = requireRow(db, id);
    return {
      ...view(task),
      ...noteView(db, id, task.status),
      ...extrasOf(db, task),
    };
  });
}

/** 人工修正：title / brief / status 等；status 经状态机的 manual_set。 */
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
    "brief",
    "brief_path",
    "by",
    "status",
    "deliver",
    "issue",
    "after",
    "after_pr",
    "auto",
    "avoid_host",
    "priority",
    "pr_url",
    "from",
    "part",
    "secret",
  ]);
  if (!Object.keys(input).length)
    throw usage(
      "至少修改一项：title、brief、brief_path、by、from、part、also、secret、status、deliver、issue、after、after_pr、auto、avoid_host、priority、pr_url",
    );
  const fields: Record<string, string | number | null> = {};
  if ("title" in input) fields.title = title(input.title);
  if ("deliver" in input) fields.deliver = deliverOf(input.deliver);
  if ("issue" in input) fields.issue = issueOf(input.issue);
  // 优先级随时可改：排队中的下一轮拉起按新档位排；已在跑的不打断。
  if ("priority" in input) fields.prio = parsePriority(input.priority);
  if ("avoid_host" in input) fields.avoid_hosts = avoidOf(input) ?? null;
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
  const secrets =
    "secret" in input ? parseSecretNames(input.secret) : undefined;
  return atomically(db, () => {
    const current = requireRow(db, id);
    if ("brief" in input || "brief_path" in input)
      Object.assign(fields, briefOf(input, current.repo));
    if ("by" in input) {
      const by_ = byOf(input.by);
      fields.job_id = by_ ? getJobRole(db, by_).id : null;
    }
    if (
      current.status === "running" &&
      "job_id" in fields &&
      fields.job_id !== current.job_id
    )
      throw new Problem(
        409,
        "执行中不能修改 --by：本轮专员已附进提示词",
        "conflict",
      );
    if ("from" in input) fields.origin_node_id = fromNode(db, input.from);
    if ("part" in input) fields.part_id = partOf(db, input);
    const part = (
      "part_id" in fields
        ? fields.part_id
        : (current.part_id ?? current.node_id)
    ) as number | null;
    if (fields.pr_url !== undefined && current.status === "running")
      throw new Problem(409, "执行中不能人工补登 PR", "conflict");
    setConditions(db, id, input, now);
    if (secrets) {
      // 执行中改也行：本轮环境已定，下一轮拉起按新的注入。
      checkTaskSecrets(db, part, secrets);
      const before = taskSecretNames(db, id);
      writeTaskSecrets(db, id, secrets);
      if (before.join(",") !== secrets.join(","))
        addEvent(db, id, now, "secrets", { from: before, to: secrets });
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
      // 详述内容可能很长，事件里只记改了多少字。
      addEvent(
        db,
        id,
        now,
        "edited",
        "brief" in changed
          ? {
              ...changed,
              brief: changed.brief
                ? `已更新（${Array.from(String(changed.brief)).length} 字）`
                : "已清空",
            }
          : changed,
      );
    }
    if (target !== undefined)
      applyTransition(db, current, { kind: "manual_set", to: target }, now);
    const task = requireRow(db, id);
    return {
      ...view(task),
      ...noteView(db, id, task.status),
      ...extrasOf(db, task),
    };
  });
}
