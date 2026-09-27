import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clipBrief } from "./brief.ts";
import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { nodeByAddress, ref, type NodeRow } from "../org/model.ts";
import { taskDir } from "./active.ts";
import {
  checklistOf,
  concernsFor,
  specialistsFor,
  specialistRef,
} from "./concerns.ts";
import { getJobRole } from "./job-roles.ts";
import {
  opinionBrief,
  opinionOf,
  STANCE_LABEL,
  type OpinionEntry,
  type Stance,
  type Topic,
} from "./council-gate.ts";
import { createTask, getTask, noteTask } from "./ledger.ts";
import {
  all,
  atomically,
  one,
  parseTaskRef,
  requireRow,
  taskRef,
  usage,
  type TaskEventRow,
} from "./ledger-model.ts";
import { objectOf, onlyKeys, ownerOf } from "./ledger-validate.ts";
import { reasonOf } from "./top.ts";

/**
 * 会审的账（#322 第 3 步）：一场会审是一个议题任务（task_councils 一行）加每位受邀专员一个意见子任务（council_members）。
 * 议题任务在专员意见收齐后由运行时写好汇总详述、派给 leader 汇总（它自己的执行者运行就是汇总），
 * 汇总完成后记结论与「需用户拍板」。这里只读写账与写详述文件；判定在 council-gate.ts，编排在 council-runtime.ts。
 */

export type CouncilStage = "opinions" | "summarizing" | "decided" | "escalated";

export const STAGE_LABEL: Record<CouncilStage, string> = {
  opinions: "等专员意见",
  summarizing: "leader 汇总中",
  decided: "已定",
  escalated: "需用户拍板",
};

export type CouncilRow = {
  task_id: number;
  topic: string;
  /** 议题详述的来源路径（旧库只有它）。 */
  topic_brief: string | null;
  /** 议题详述内容（#355）；汇总时议题任务的详述会换成汇总详述，议题原文留在这里。 */
  topic_text: string | null;
  leader_node_id: number | null;
  comment: number;
  stage: CouncilStage;
  conclusion: string | null;
  escalate: string | null;
  agreed: string | null;
  conflicts: string | null;
  decided_by: string | null;
  decided_at: number | null;
  created_at: number;
};

export type MemberRow = {
  task_id: number;
  node_id: number;
  pos: number;
  opinion_id: number;
};

export function ensureCouncilTables(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_councils (
    task_id INTEGER PRIMARY KEY REFERENCES tasks(id), topic TEXT NOT NULL, topic_brief TEXT,
    leader_node_id INTEGER, comment INTEGER NOT NULL DEFAULT 0,
    stage TEXT NOT NULL CHECK(stage IN ('opinions','summarizing','decided','escalated')),
    conclusion TEXT, escalate TEXT, agreed TEXT, conflicts TEXT, decided_by TEXT, decided_at INTEGER,
    created_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS task_councils_stage ON task_councils(stage,task_id);
  CREATE TABLE IF NOT EXISTS council_members (
    task_id INTEGER NOT NULL REFERENCES tasks(id), node_id INTEGER NOT NULL, pos INTEGER NOT NULL,
    opinion_id INTEGER NOT NULL, PRIMARY KEY(task_id,node_id));
  CREATE INDEX IF NOT EXISTS council_members_opinion ON council_members(opinion_id);`);
  const columns = all<{ name: string }>(db, "PRAGMA table_info(task_councils)");
  if (!columns.some((column) => column.name === "topic_text"))
    db.exec("ALTER TABLE task_councils ADD COLUMN topic_text TEXT");
}

export const councilRow = (db: DatabaseSync, id: number) =>
  one<CouncilRow>(db, "SELECT * FROM task_councils WHERE task_id=?", id);

export const memberRows = (db: DatabaseSync, id: number) =>
  all<MemberRow>(
    db,
    "SELECT * FROM council_members WHERE task_id=? ORDER BY pos LIMIT 50",
    id,
  );

/** 这个任务是某场会审的专员意见任务。 */
export const isOpinionTask = (db: DatabaseSync, id: number) =>
  !!one(db, "SELECT 1 FROM council_members WHERE opinion_id=? LIMIT 1", id);

export const isCouncilTask = (db: DatabaseSync, id: number) =>
  !!councilRow(db, id);

/** 会审的议题上下文（写进意见与汇总详述）。 */
export function topicOf(db: DatabaseSync, id: number): Topic {
  const council = councilRow(db, id)!;
  const task = getTask(db, id);
  return {
    ref: task.ref,
    topic: council.topic,
    brief: council.topic_text,
    brief_path: council.topic_brief,
    issue: task.issue,
    repo: task.repo,
    leader: leaderLabel(db, council.leader_node_id),
    concerns: memberRows(db, id).map((m) => ({
      ref: specialistRef(m.node_id),
      name: nodeName(db, m.node_id),
    })),
  };
}

const nodeName = (db: DatabaseSync, id: number) =>
  id < 0
    ? getJobRole(db, `r${-id}`).name
    : (one<NodeRow>(db, "SELECT * FROM org_nodes WHERE id=?", id)?.name ??
      ref(id));

const leaderLabel = (db: DatabaseSync, id: number | null) =>
  id === null ? "秘书" : `${nodeName(db, id)}（${ref(id)}）的 leader`;

const TOPIC_MAX = 120;

/** leader 节点：按地址解析，报错带候选。 */
function leaderNode(db: DatabaseSync, address: string): NodeRow {
  try {
    return nodeByAddress(db, address);
  } catch (error) {
    if (error instanceof Problem)
      throw new Problem(
        400,
        `leader: ${error.message}`,
        "usage",
        error.candidates,
        "atrium org tree",
      );
    throw error;
  }
}

/** 受邀专员：同 task --concern 的写法，报错里的字段名换成 concerns。 */
function invited(db: DatabaseSync, value: unknown) {
  try {
    return specialistsFor(db, value);
  } catch (error) {
    if (error instanceof Problem && error.code === "not_found")
      try {
        return concernsFor(db, value);
      } catch (legacyError) {
        if (
          legacyError instanceof Problem &&
          legacyError.message.startsWith("concern: ")
        )
          throw new Problem(
            legacyError.statusCode,
            `concerns: ${legacyError.message.slice("concern: ".length)}`,
            legacyError.code,
            legacyError.candidates,
            legacyError.nextCommand,
          );
        throw legacyError;
      }
    if (error instanceof Problem && error.message.startsWith("concern: "))
      throw new Problem(
        error.statusCode,
        `concerns: ${error.message.slice("concern: ".length)}`,
        error.code,
        error.candidates,
        error.nextCommand,
      );
    throw error;
  }
}

/**
 * 发起会审：建议题任务（role 为 leader 节点，缺省秘书；有 --comment 时交付为 issue 评论）与每位专员一个意见子任务，
 * 意见详述写进议题任务目录。返回议题任务与意见任务短号；拉起由调用方做。
 */
export function createCouncil(db: DatabaseSync, data: string, body: unknown) {
  const input = objectOf(body);
  onlyKeys(input, [
    "topic",
    "concerns",
    "brief",
    "brief_path",
    "issue",
    "leader",
    "repo",
    "owner",
    "part",
    "comment",
  ]);
  if (typeof input.topic !== "string" || !input.topic.trim())
    throw usage(
      "topic: 议题不能为空",
      "atrium review add 议题 --concerns 前端,后端",
    );
  const topic = input.topic.trim().replace(/\s+/g, " ");
  if (Array.from(topic).length > TOPIC_MAX)
    throw usage(`topic: 议题至多 ${TOPIC_MAX} 字，长内容写进 --brief 文件`);
  if (input.concerns === undefined || input.concerns === "")
    throw usage("concerns: 至少请一位专员，如 前端,后端");
  const comment = input.comment === true;
  if (input.comment !== undefined && typeof input.comment !== "boolean")
    throw usage("comment: 应为 true 或 false");
  if (comment && (input.issue === undefined || input.issue === null))
    throw usage("comment: 同步为 issue 评论需同时给 issue");
  if (comment && !input.repo)
    throw usage("comment: 同步为 issue 评论需同时给 repo（gh 据此定仓库）");
  if (
    input.leader !== undefined &&
    input.leader !== null &&
    input.leader !== ""
  )
    if (typeof input.leader !== "string")
      throw usage("leader: 应为组织节点，如 atrium 或 o2");
  if (input.owner !== undefined) ownerOf(input.owner);
  return atomically(db, () => {
    const concerns = invited(db, input.concerns);
    if (!concerns.length) throw usage("concerns: 至少请一位专员，如 前端,后端");
    const leader = input.leader ? leaderNode(db, String(input.leader)) : null;
    const now = Date.now();
    const parent = createTask(
      db,
      {
        title: `会审：${topic}`,
        deliver: comment ? "comment" : "none",
        ...(leader ? { role: ref(leader.id) } : {}),
        ...(input.brief !== undefined ? { brief: input.brief } : {}),
        ...(input.brief_path ? { brief_path: input.brief_path } : {}),
        ...(input.issue !== undefined ? { issue: input.issue } : {}),
        ...(input.repo ? { repo: input.repo } : {}),
        ...(input.owner ? { owner: input.owner } : {}),
        ...(input.part ? { part: input.part } : {}),
      },
      now,
    );
    db.prepare(
      "INSERT INTO task_councils(task_id,topic,topic_brief,topic_text,leader_node_id,comment,stage,created_at) VALUES(?,?,?,?,?,?,'opinions',?)",
    ).run(
      parent.id,
      topic,
      parent.brief_path,
      parent.brief ?? null,
      leader?.id ?? null,
      comment ? 1 : 0,
      now,
    );
    const dir = taskDir(data, parent.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const refs: string[] = [];
    concerns.forEach((nodeId, pos) => {
      // 先登记成员，议题上下文里才列得出全部受邀专员。
      db.prepare(
        "INSERT INTO council_members(task_id,node_id,pos,opinion_id) VALUES(?,?,?,0)",
      ).run(parent.id, nodeId, pos);
    });
    const topicView = topicOf(db, parent.id);
    for (const nodeId of concerns) {
      const checklist = checklistOf(db, nodeId);
      const brief = join(dir, `opinion-${checklist.ref}.md`);
      const text = clipBrief(opinionBrief(topicView, checklist));
      writeFileSync(brief, text, { mode: 0o600 });
      const opinion = createTask(
        db,
        {
          title: `会审意见：${checklist.name} · ${topic}`,
          parent: parent.ref,
          ...(nodeId < 0 ? { job: checklist.ref } : { role: checklist.ref }),
          deliver: "none",
          brief: text,
          brief_path: brief,
          ...(input.owner ? { owner: input.owner } : {}),
          ...(input.part ? { part: input.part } : {}),
        },
        now,
      );
      db.prepare(
        "UPDATE council_members SET opinion_id=? WHERE task_id=? AND node_id=?",
      ).run(opinion.id, parent.id, nodeId);
      refs.push(opinion.ref);
    }
    noteTask(db, parent.id, "council_opened", {
      topic,
      leader: leader ? ref(leader.id) : "secretary",
      opinions: refs,
      ...(comment ? { comment: true } : {}),
    });
    return { council: councilView(db, parent.id), opinions: refs };
  });
}

export type OpinionView = OpinionEntry & { status: string };

export type CouncilView = {
  ref: string;
  topic: string;
  title: string;
  status: string;
  stage: CouncilStage;
  stage_label: string;
  leader: { ref: string; name: string } | null;
  issue: number | null;
  comment: boolean;
  repo: string | null;
  topic_brief: string | null;
  opinions: OpinionView[];
  summary: { task: string; status: string; text: string | null };
  agreed: string[];
  conflicts: string[];
  conclusion: string | null;
  escalate: string[];
  decided_by: string | null;
  decided_at: number | null;
};

const list = (text: string | null): string[] => {
  try {
    const value = text ? JSON.parse(text) : [];
    return Array.isArray(value)
      ? value.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
};

function lastReason(db: DatabaseSync, id: number, kind: string) {
  return reasonOf(
    all<TaskEventRow>(
      db,
      "SELECT * FROM task_events WHERE task_id=? AND kind=? ORDER BY id DESC LIMIT 1",
      id,
      kind,
    ),
    kind,
  );
}

/** 各专员意见任务的现状与立场；还在跑的立场为 none、原因写现状。 */
export function opinionsOf(db: DatabaseSync, id: number): OpinionView[] {
  return memberRows(db, id).map((m) => {
    const task = one<{ status: string; result: string | null }>(
      db,
      "SELECT status,result FROM tasks WHERE id=?",
      m.opinion_id,
    );
    const status = task?.status ?? "cancelled";
    const reason =
      status === "failed"
        ? lastReason(db, m.opinion_id, "exit_fail")
        : status === "blocked"
          ? lastReason(db, m.opinion_id, "block")
          : null;
    const opinion = opinionOf(status, task?.result ?? null, reason) ?? {
      stance: "none" as Stance,
      reason: status === "running" ? "正在出意见" : "还没开始",
    };
    return {
      ref: specialistRef(m.node_id),
      name: nodeName(db, m.node_id),
      task: taskRef(m.opinion_id),
      status,
      stance: opinion.stance,
      reason: opinion.reason,
      text: status === "done" ? (task?.result ?? null) : null,
    };
  });
}

export function councilView(db: DatabaseSync, reference: unknown): CouncilView {
  const id = parseTaskRef(reference);
  requireRow(db, id);
  const council = councilRow(db, id);
  if (!council)
    throw new Problem(
      404,
      `${taskRef(id)} 不是会审议题`,
      "not_found",
      undefined,
      `atrium task show ${taskRef(id)}`,
    );
  const task = getTask(db, id);
  return {
    ref: task.ref,
    topic: council.topic,
    title: task.title,
    status: task.status,
    stage: council.stage,
    stage_label: STAGE_LABEL[council.stage],
    leader:
      council.leader_node_id === null
        ? null
        : {
            ref: ref(council.leader_node_id),
            name: nodeName(db, council.leader_node_id),
          },
    issue: task.issue,
    comment: council.comment === 1,
    repo: task.repo,
    topic_brief: council.topic_brief,
    opinions: opinionsOf(db, id),
    summary: {
      task: task.ref,
      status: task.status,
      text:
        council.stage === "decided" || council.stage === "escalated"
          ? task.result
          : null,
    },
    agreed: list(council.agreed),
    conflicts: list(council.conflicts),
    conclusion: council.conclusion,
    escalate: list(council.escalate),
    decided_by: council.decided_by,
    decided_at: council.decided_at,
  };
}

/** 一位专员的意见，一句人话。 */
export const opinionLine = (o: OpinionView) =>
  `${o.name}（${o.ref} · ${o.task}）：${STANCE_LABEL[o.stance]}${o.reason ? `——${o.reason}` : ""}`;

const DECISION_MAX = 2000;

/** 用户（或其授权的上层）对上交的会审拍板：记结论与拍板人，阶段转已定；原上交事项保留。 */
export function decideCouncil(
  db: DatabaseSync,
  reference: unknown,
  body: unknown,
  actor: string,
) {
  const id = parseTaskRef(reference);
  const input = objectOf(body);
  onlyKeys(input, ["conclusion"]);
  if (typeof input.conclusion !== "string" || !input.conclusion.trim())
    throw usage("conclusion: 结论不能为空");
  const conclusion = input.conclusion.trim();
  if (Array.from(conclusion).length > DECISION_MAX)
    throw usage(`conclusion: 结论至多 ${DECISION_MAX} 字`);
  return atomically(db, () => {
    const council = councilView(db, id);
    if (council.stage !== "escalated" && council.stage !== "decided")
      throw new Problem(
        409,
        `${council.ref} 还没汇总完（${council.stage_label}），等 leader 汇总后再拍板`,
        "conflict",
        undefined,
        `atrium task wait ${council.ref}`,
      );
    const now = Date.now();
    db.prepare(
      "UPDATE task_councils SET stage='decided',conclusion=?,decided_by=?,decided_at=? WHERE task_id=?",
    ).run(conclusion, actor, now, id);
    noteTask(db, id, "council_decided", {
      conclusion,
      by: actor,
      ...(council.escalate.length ? { resolved: council.escalate } : {}),
    });
    return councilView(db, id);
  });
}
