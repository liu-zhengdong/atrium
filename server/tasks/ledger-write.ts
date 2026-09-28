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
  aspectPart,
  defaultPriority,
  parsePriority,
  priorityAfterMove,
} from "./priority.ts";
import {
  concernRows,
  concernsFor,
  specialistsFor,
  specialistRef,
  concernsOf,
  textHints,
  writeConcerns,
} from "./concerns.ts";
import { getJobRole } from "./job-roles.ts";
import { ref as nodeRef } from "../org/model.ts";
import { briefText, readBriefFile } from "./brief.ts";
import { specialistOptions } from "./specialist-options.ts";
import {
  alsoFor,
  alsoOf,
  involvedOf,
  involvedView,
  writeAlso,
} from "./also.ts";
import { checkSpecialists } from "./specialist-scope.ts";
import { syncTotals } from "./rollup-ledger.ts";

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
function urgentOf(value: unknown) {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw usage("urgent: 应为 true 或 false");
  return value;
}

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
  job?: string | null;
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
  /** 投任务的节点（关注点往模块投时）。 */
  from?: string | null;
  /** 归属哪一部分（组织节点）。 */
  part?: string | null;
  /** 旧写法：gN 按目标树迁移映射到该目标的负责节点，等同 part。 */
  goal?: string | null;
  /** 牵涉的部分（#373），逗号分隔。 */
  also?: string | null;
  /** 请哪些专员：关注点节点，逗号分隔。 */
  concern?: string | null;
  ask?: string | null;
};

/** 任务读回时带上请的专员与牵涉的部分，改请专员或建任务时再带上按标题详述给的提示。 */
function withConcerns(db: DatabaseSync, task: TaskRow, hints: boolean) {
  const concerns = concernsOf(db, task.id);
  const concern_hints = hints ? textHints(db, task) : [];
  return {
    ...(concerns.length ? { concerns } : {}),
    ...(concern_hints.length ? { concern_hints } : {}),
    ...involvedView(involvedOf(db, task)),
  };
}

/** 请的专员（`--by` 与 `--ask`）须在任务范围里：归属链、牵涉部分与全组织的（#373）。 */
function checkScope(
  db: DatabaseSync,
  task: { part: number | null; also: readonly number[] },
  job: number | null,
  concerns: readonly number[],
  byFlag: string,
) {
  checkSpecialists(db, task, [
    { flag: byFlag, ids: job ? [job] : [] },
    { flag: "ask", ids: concerns.filter((id) => id < 0).map((id) => -id) },
  ]);
}

export function createTask(
  db: DatabaseSync,
  body: unknown,
  now = Date.now(),
  /** 建任务的 leader（aN）：记进 created 事件，全景据此显示「谁派的」。 */
  by?: string,
  /** 运行时替父任务建的帮手（专员审查、会审意见）：不让父任务变成总任务（t190）。 */
  internal: { helper?: boolean } = {},
): Task {
  const input = objectOf(body);
  onlyKeys(input, [
    "title",
    "parent",
    "role",
    "job",
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
    "priority",
    "from",
    "part",
    "goal",
    "concern",
    "ask",
    "also",
  ]);
  const specialist = specialistOptions(input);
  const urgent = urgentOf(input.urgent);
  const priority =
    input.priority === undefined ? undefined : parsePriority(input.priority);
  const deliver = input.deliver === undefined ? "pr" : deliverOf(input.deliver);
  const issue = issueOf(input.issue);
  validateDeliver(deliver, issue);
  const repo = repoOf(input.repo);
  const values = {
    owner:
      input.owner === undefined || input.owner === null || input.owner === ""
        ? null
        : ownerOf(input.owner),
    title: title(input.title),
    role: optionalText(input.role, "role", 200),
    repo,
    ...briefOf(input, repo),
  };
  return atomically(db, () => {
    const parent = parentOf(db, input.parent);
    let oldRoleSpecialist: number | null = null;
    if (values.role && !specialist.byPresent)
      try {
        oldRoleSpecialist = getJobRole(db, values.role).id;
      } catch (error) {
        if (!(error instanceof Problem) || error.statusCode !== 404)
          throw error;
      }
    const role = oldRoleSpecialist ? null : values.role;
    const node = roleNode(db, role, values.repo);
    const job = specialist.by
      ? getJobRole(db, specialist.by).id
      : oldRoleSpecialist;
    const origin = fromNode(db, input.from);
    const part = partOf(db, input);
    const concerns = specialist.modernAsk
      ? specialistsFor(db, specialist.ask)
      : concernsFor(db, specialist.ask);
    const also = alsoFor(db, input.also);
    checkScope(
      db,
      { part: part ?? node, also },
      job,
      concerns,
      oldRoleSpecialist ? "role" : "by",
    );
    const level = priority ?? defaultPriority(aspectPart(db, part ?? node));
    const { lastInsertRowid } = db
      .prepare(
        "INSERT INTO tasks(parent_id,helper,title,brief,brief_path,role,repo,owner,deliver,issue,node_id,origin_node_id,part_id,job_id,urgent,priority,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'todo',?,?)",
      )
      .run(
        parent,
        internal.helper && parent ? 1 : 0,
        values.title,
        values.brief,
        values.brief_path,
        role,
        values.repo,
        values.owner,
        deliver,
        issue,
        node,
        origin,
        part,
        job,
        urgent ? 1 : 0,
        level,
        now,
        now,
      );
    const id = Number(lastInsertRowid);
    setConditions(db, id, input, now);
    writeConcerns(db, id, concerns);
    writeAlso(db, id, also);
    addEvent(db, id, now, "created", {
      title: values.title,
      ...(parent ? { parent: taskRef(parent) } : {}),
      ...(node ? { node: `o${node}` } : {}),
      ...(origin ? { from: `o${origin}` } : {}),
      ...(part ? { part: `o${part}` } : {}),
      ...(job ? { job: `r${job}` } : {}),
      ...(concerns.length ? { concerns: concerns.map(specialistRef) } : {}),
      ...(urgent ? { urgent: true } : {}),
      ...(level === "idle" ? { priority: level } : {}),
      ...(also.length ? { also: also.map(nodeRef) } : {}),
      ...(by ? { by } : {}),
    });
    // 父任务有了子任务就是总任务（t190）：撤出排队，已结束的按汇总改回待办。
    if (parent && !internal.helper) syncTotals(db, id, now);
    const task = requireRow(db, id);
    return {
      ...view(task),
      ...noteView(db, id, task.status),
      ...withConcerns(db, task, true),
    };
  });
}

/** 人工修正：title / brief / role / status；status 经状态机的 manual_set。 */
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
    "role",
    "job",
    "by",
    "status",
    "deliver",
    "issue",
    "after",
    "after_pr",
    "auto",
    "urgent",
    "priority",
    "pr_url",
    "from",
    "part",
    "goal",
    "concern",
    "ask",
    "also",
  ]);
  const specialist = specialistOptions(input);
  if (!Object.keys(input).length)
    throw usage(
      "至少修改一项：title、brief、brief_path、role、job、from、part、also、concern、status、deliver、issue、after、after_pr、auto、urgent、priority、pr_url",
    );
  const fields: Record<string, string | number | null> = {};
  if ("title" in input) fields.title = title(input.title);
  if ("role" in input) fields.role = optionalText(input.role, "role", 200);
  if ("deliver" in input) fields.deliver = deliverOf(input.deliver);
  if ("issue" in input) fields.issue = issueOf(input.issue);
  // 紧急随时可改（在跑、排队中也行）：排队中的下一轮巡检按新标记拉起。
  if ("urgent" in input) fields.urgent = urgentOf(input.urgent) ? 1 : 0;
  // 闲时随时可改：排队中的下一轮拉起按新档位排；已在跑的不打断。
  if ("priority" in input) fields.priority = parsePriority(input.priority);
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
    if ("brief" in input || "brief_path" in input)
      Object.assign(fields, briefOf(input, current.repo));
    if (specialist.byPresent)
      fields.job_id = specialist.by ? getJobRole(db, specialist.by).id : null;
    if ("role" in fields) {
      let oldRoleSpecialist: number | null = null;
      if (fields.role && !specialist.byPresent)
        try {
          oldRoleSpecialist = getJobRole(db, fields.role).id;
        } catch (error) {
          if (!(error instanceof Problem) || error.statusCode !== 404)
            throw error;
        }
      if (oldRoleSpecialist) {
        fields.job_id = oldRoleSpecialist;
        fields.role = null;
        fields.node_id = null;
      } else
        fields.node_id = roleNode(
          db,
          fields.role as string | null,
          current.repo,
        );
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
    if ("part" in input || "goal" in input) fields.part_id = partOf(db, input);
    // 换了归属部分、又没同时指定档位：没被人改过的档位跟着新部分的缺省走。
    if (!("priority" in fields) && ("part_id" in fields || "node_id" in fields))
      fields.priority = priorityAfterMove(
        current.priority,
        aspectPart(db, current.part_id ?? current.node_id),
        aspectPart(
          db,
          ((("part_id" in fields ? fields.part_id : current.part_id) ??
            ("node_id" in fields ? fields.node_id : current.node_id)) as
            number | null) ?? null,
        ),
      );
    if (fields.pr_url !== undefined && current.status === "running")
      throw new Problem(409, "执行中不能人工补登 PR", "conflict");
    const concerns = specialist.askPresent
      ? specialist.modernAsk
        ? specialistsFor(db, specialist.ask)
        : concernsFor(db, specialist.ask)
      : undefined;
    if (concerns && current.status === "running")
      throw new Problem(
        409,
        "执行中不能改请的专员：提示词已经发出；等它结束再改，下一轮生效",
        "conflict",
        undefined,
        `atrium task wait ${taskRef(id)}`,
      );
    const also = "also" in input ? alsoFor(db, input.also) : undefined;
    if (
      "job_id" in fields ||
      concerns ||
      also ||
      "part_id" in fields ||
      "node_id" in fields
    ) {
      const job = "job_id" in fields ? fields.job_id : current.job_id;
      checkScope(
        db,
        {
          part:
            ("part_id" in fields ? fields.part_id : current.part_id) ??
            ("node_id" in fields ? fields.node_id : current.node_id),
          also: also ?? alsoOf(db, id),
        } as { part: number | null; also: number[] },
        (job as number | null) ?? null,
        concerns ?? concernRows(db, id).map((row) => row.node_id),
        "role" in input && !specialist.byPresent ? "role" : "by",
      );
    }
    setConditions(db, id, input, now);
    if (also) {
      const before = alsoOf(db, id).map(nodeRef);
      writeAlso(db, id, also);
      const after = also.map(nodeRef);
      if (before.join(",") !== after.join(","))
        addEvent(db, id, now, "also", { from: before, to: after });
    }
    if (concerns) {
      const before = concernRows(db, id).map((row) =>
        specialistRef(row.node_id),
      );
      writeConcerns(db, id, concerns);
      const after = concerns.map(specialistRef);
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
      ...withConcerns(db, task, concerns !== undefined || "title" in input),
    };
  });
}
