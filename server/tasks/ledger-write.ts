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
import { originNode } from "../org/task-node.ts";
import { partForTask } from "../org/task-part.ts";
import {
  aspectPart,
  defaultPriority,
  parsePriority,
  priorityAfterMove,
} from "./priority.ts";
import { parseSize, type Size } from "./task-size.ts";
import {
  inferType,
  parseTaskType,
  storedType,
  type TypeSource,
} from "./task-type.ts";
import { getJobRole } from "./job-roles.ts";
import { ref as nodeRef } from "../org/model.ts";
import { briefText, readBriefFile } from "./brief.ts";
import {
  alsoFor,
  alsoOf,
  involvedOf,
  involvedView,
  writeAlso,
} from "./also.ts";
import { parseSecretNames } from "../secrets/model.ts";
import {
  checkTaskSecrets,
  taskSecretNames,
  writeTaskSecrets,
} from "../secrets/store.ts";
import { checkSpecialists } from "./specialist-scope.ts";
import { syncTotals } from "./rollup-ledger.ts";
import {
  avoidHostsOf,
  parseStopgap,
  stopgapJson,
  whyOf,
  type StopgapAction,
} from "./urgent.ts";

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

/** 紧急标记（t113）：只认布尔值；只按这个字段判断，标题写「紧急：」不算。 */
/** 大小：小 / 中 / 大（或英文）；null 与空串表示不写。 */
function sizeOf(value: unknown): Size | null {
  return value === undefined || value === null || value === ""
    ? null
    : parseSize(value);
}

function urgentOf(value: unknown) {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw usage("urgent: 应为 true 或 false");
  return value;
}

/**
 * 紧急通道的附加字段（t215）：原因（why）、避开的主机（avoid_host）、止损动作（stopgap）。
 * 止损动作只给紧急任务写；返回要写进 tasks 的列（没给的不在里面）与解析后的止损动作。
 */
function urgentExtras(
  input: Record<string, unknown>,
  urgent: boolean,
): { fields: Record<string, string | null>; stopgap: StopgapAction[] } {
  const fields: Record<string, string | null> = {};
  if ("why" in input) fields.urgent_why = whyOf(input.why);
  if ("avoid_host" in input) {
    const hosts = avoidHostsOf(input.avoid_host);
    fields.avoid_hosts = hosts.length ? JSON.stringify(hosts) : null;
  }
  const stopgap = "stopgap" in input ? parseStopgap(input.stopgap) : [];
  if (stopgap.length && !urgent)
    throw usage("stopgap: 只有紧急任务能写止损动作，加上 --urgent");
  if ("stopgap" in input)
    fields.stopgap = stopgap.length
      ? JSON.stringify(stopgapJson(stopgap))
      : null;
  return { fields, stopgap };
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
  /** 紧急：跳过本机负载限制，排队插到最前。 */
  urgent?: boolean;
  /** 闲时 / 普通（t136）；不写按归属部分：管方面的为闲时。 */
  priority?: string;
  /** 小 / 中 / 大（t276）；不写挑人时粗估。 */
  size?: string;
  /** 功能 / 修复（t237）；不写按来源、标题、父任务推断。 */
  type?: string;
  /** 投任务的节点（关注点往模块投时）。 */
  from?: string | null;
  /** 归属哪一部分（组织节点）。 */
  part?: string | null;
  /** 牵涉的部分（#373），逗号分隔。 */
  also?: string | null;
  /** 要用的凭据名称（t194），逗号分隔；派活时按名称注入执行者环境。 */
  secret?: string | null;
};

/** 任务读回时带上牵涉的部分与凭据名称。 */
function extrasOf(db: DatabaseSync, task: TaskRow) {
  const secrets = taskSecretNames(db, task.id);
  return {
    ...involvedView(involvedOf(db, task)),
    ...(secrets.length ? { secrets } : {}),
  };
}

/** 干活的专员（`--by`）须在任务范围里：归属链、牵涉部分与全组织的（#373）。 */
function checkScope(
  db: DatabaseSync,
  task: { part: number | null; also: readonly number[] },
  job: number | null,
) {
  checkSpecialists(db, task, [{ flag: "by", ids: job ? [job] : [] }]);
}

/** `by`：专员名称或短号；null 与空串表示不指定。 */
function byOf(value: unknown) {
  if (value !== undefined && value !== null && typeof value !== "string")
    throw usage("by: 应为专员名称或短号");
  return value || null;
}

/** 父任务的类型：子任务不写类型、标题也看不出时跟它走（t237）。 */
const parentType = (db: DatabaseSync, parent: number) =>
  storedType(
    (
      db.prepare("SELECT task_type FROM tasks WHERE id=?").get(parent) as
        { task_type: string } | undefined
    )?.task_type,
  );

export function createTask(
  db: DatabaseSync,
  body: unknown,
  now = Date.now(),
  /** 建任务的 leader（aN）：记进 created 事件，全景据此显示「谁派的」。 */
  by?: string,
  /**
   * 运行时替父任务建的帮手（审阅、上线验证）：不让父任务变成总任务（t190）。
   * source：运行时知道任务从哪来时给（选项单、巡检、上线验证、关卡交回），没写 type 时据此定类型（t237）。
   */
  internal: { helper?: boolean; source?: TypeSource } = {},
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
    "urgent",
    "why",
    "avoid_host",
    "stopgap",
    "priority",
    "size",
    "type",
    "from",
    "part",
    "also",
    "secret",
  ]);
  const by_ = byOf(input.by);
  const size = sizeOf(input.size);
  const urgent = urgentOf(input.urgent);
  const type = input.type === undefined ? undefined : parseTaskType(input.type);
  const extras = urgentExtras(input, urgent);
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
    const also = alsoFor(db, input.also);
    checkScope(db, { part, also }, job);
    checkTaskSecrets(db, part, secrets);
    const level = priority ?? defaultPriority(aspectPart(db, part));
    const kind =
      type ??
      inferType({
        title: values.title,
        source: internal.source ?? null,
        parent: parent ? parentType(db, parent) : null,
      });
    const { lastInsertRowid } = db
      .prepare(
        "INSERT INTO tasks(parent_id,helper,title,brief,brief_path,repo,owner,deliver,issue,origin_node_id,part_id,job_id,urgent,priority,task_type,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'todo',?,?)",
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
        urgent ? 1 : 0,
        level,
        kind,
        now,
        now,
      );
    const id = Number(lastInsertRowid);
    const extra = {
      ...extras.fields,
      ...(urgent ? { urgent_by: by ?? null } : {}),
      ...(size ? { size } : {}),
    };
    if (Object.keys(extra).length)
      db.prepare(
        `UPDATE tasks SET ${Object.keys(extra)
          .map((key) => `${key}=?`)
          .join(",")} WHERE id=?`,
      ).run(...Object.values(extra), id);
    setConditions(db, id, input, now);
    writeAlso(db, id, also);
    writeTaskSecrets(db, id, secrets);
    addEvent(db, id, now, "created", {
      title: values.title,
      ...(parent ? { parent: taskRef(parent) } : {}),
      ...(origin ? { from: `o${origin}` } : {}),
      ...(part ? { part: `o${part}` } : {}),
      ...(job ? { job: `r${job}` } : {}),
      ...(urgent ? { urgent: true } : {}),
      ...(extras.fields.urgent_why ? { why: extras.fields.urgent_why } : {}),
      ...(extras.stopgap.length
        ? { stopgap: stopgapJson(extras.stopgap) }
        : {}),
      ...(level === "idle" ? { priority: level } : {}),
      ...(size ? { size } : {}),
      type: kind,
      ...(also.length ? { also: also.map(nodeRef) } : {}),
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
  /** 改任务的 leader（aN）；用户与秘书不给。 */
  options: { by?: string } = {},
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
    "urgent",
    "why",
    "avoid_host",
    "stopgap",
    "priority",
    "size",
    "type",
    "pr_url",
    "from",
    "part",
    "also",
    "secret",
  ]);
  if (!Object.keys(input).length)
    throw usage(
      "至少修改一项：title、brief、brief_path、by、from、part、also、secret、status、deliver、issue、after、after_pr、auto、urgent、why、avoid_host、stopgap、priority、size、type、pr_url",
    );
  const fields: Record<string, string | number | null> = {};
  if ("title" in input) fields.title = title(input.title);
  if ("deliver" in input) fields.deliver = deliverOf(input.deliver);
  if ("issue" in input) fields.issue = issueOf(input.issue);
  // 紧急随时可改（在跑、排队中也行）：排队中的下一轮巡检按新标记拉起。
  if ("urgent" in input) fields.urgent = urgentOf(input.urgent) ? 1 : 0;
  // 闲时随时可改：排队中的下一轮拉起按新档位排；已在跑的不打断。
  if ("priority" in input) fields.priority = parsePriority(input.priority);
  // 大小随时可改（给空清掉、回到粗估）：只影响之后的自动挑人。
  if ("size" in input) fields.size = sizeOf(input.size);
  // 类型随时可改：排队中的下一轮按新类型算修复保底名额。
  if ("type" in input) fields.task_type = parseTaskType(input.type);
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
    const urgentNow =
      "urgent" in fields ? fields.urgent === 1 : current.urgent === 1;
    Object.assign(fields, urgentExtras(input, urgentNow).fields);
    // 新标上紧急：记下谁标的（leader 为 aN，用户与秘书为 null）。
    if (fields.urgent === 1 && current.urgent !== 1)
      fields.urgent_by = options.by ?? null;
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
    // 换了归属部分、又没同时指定档位：没被人改过的档位跟着新部分的缺省走。
    if (!("priority" in fields) && "part_id" in fields)
      fields.priority = priorityAfterMove(
        current.priority,
        aspectPart(db, current.part_id ?? current.node_id),
        aspectPart(db, part),
      );
    if (fields.pr_url !== undefined && current.status === "running")
      throw new Problem(409, "执行中不能人工补登 PR", "conflict");
    const also = "also" in input ? alsoFor(db, input.also) : undefined;
    if ("job_id" in fields || also || "part_id" in fields)
      checkScope(
        db,
        { part, also: also ?? alsoOf(db, id) },
        (("job_id" in fields ? fields.job_id : current.job_id) as
          number | null) ?? null,
      );
    setConditions(db, id, input, now);
    if (secrets) {
      // 执行中改也行：本轮环境已定，下一轮拉起按新的注入。
      checkTaskSecrets(db, part, secrets);
      const before = taskSecretNames(db, id);
      writeTaskSecrets(db, id, secrets);
      if (before.join(",") !== secrets.join(","))
        addEvent(db, id, now, "secrets", { from: before, to: secrets });
    }
    if (also) {
      const before = alsoOf(db, id).map(nodeRef);
      writeAlso(db, id, also);
      const after = also.map(nodeRef);
      if (before.join(",") !== after.join(","))
        addEvent(db, id, now, "also", { from: before, to: after });
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
