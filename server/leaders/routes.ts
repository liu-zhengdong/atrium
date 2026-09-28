import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { atomically, getTask, noteTask } from "../tasks/ledger.ts";
import type { EventInbox } from "../tasks/events.ts";
import {
  addLeader,
  editLeader,
  ensureLeaderTables,
  leaderRef,
  listLeaders,
  requireLeader,
  showLeader,
} from "./model.ts";
import { escalationDetail, forwardOf, type ForwardCandidate } from "./route.ts";
import { upstreamRoute } from "./subscriber.ts";
import { ESCALATE_KINDS, escalateInput } from "./wake.ts";
import { cloneOf } from "./guard.ts";
import { memoTarget } from "./clones.ts";
import { memoText } from "../memos/store.ts";
import { writeMemoTo } from "../memos/parts.ts";

const id = (params: unknown) => String((params as { id?: string }).id ?? "");

const CANDIDATES_MAX = 20;

/** 可能被转交的下层上交：指定编号的那条，或同任务最近几条投给这位 leader 的上交（走 task_inbox_task 索引）。 */
function forwardCandidates(
  db: DatabaseSync,
  leader: string,
  event: number | null,
  taskId: number | null,
): ForwardCandidate[] {
  const rows = (
    event !== null
      ? db.prepare("SELECT * FROM task_inbox WHERE id=?").all(event)
      : taskId === null
        ? []
        : db
            .prepare(
              `SELECT * FROM task_inbox WHERE task_id=? AND subscriber=? AND kind='escalated' ORDER BY id DESC LIMIT ${CANDIDATES_MAX}`,
            )
            .all(taskId, leader)
  ) as {
    id: number;
    subscriber: string;
    task_id: number | null;
    kind: string;
    actor: string | null;
    dedupe_key: string;
    acked_at: number | null;
    detail: string | null;
  }[];
  return rows.map((row) => {
    let detail: unknown = null;
    try {
      detail = row.detail === null ? null : JSON.parse(row.detail);
    } catch {
      detail = null;
    }
    return {
      id: row.id,
      subscriber: row.subscriber,
      kind: row.kind,
      task: row.task_id === null ? null : `t${row.task_id}`,
      actor: row.actor,
      key: row.dedupe_key,
      acked_at: row.acked_at,
      detail,
    };
  });
}

/**
 * leader 上交：生成一条投给上一层 leader（或秘书）的「要处理」事件，任务上也记一笔。
 * 转交下层的上交时不另起一条：沿用原事件的去重键、带上原文与这一层的意见，并替它确认手上那条，
 * 免得唤醒收尾时又把原事件转交一次。
 */
export function escalate(
  db: DatabaseSync,
  inbox: EventInbox,
  reference: string,
  body: unknown,
  now = Date.now(),
) {
  const leader = leaderRef(requireLeader(db, reference).id);
  const input = escalateInput(body);
  const given = input.task ? getTask(db, input.task) : null;
  const { forward, error } = forwardOf({
    leader,
    kind: input.kind,
    task: given?.ref ?? null,
    event: input.event,
    now,
    candidates: forwardCandidates(db, leader, input.event, given?.id ?? null),
  });
  if (error) throw new Problem(400, error, "usage");
  const task = given ?? (forward?.task ? getTask(db, forward.task) : null);
  if (input.kind === "shipped" && !task)
    throw new Problem(
      400,
      "--task: 上交「已上线」要给上线的任务，附端到端验证",
      "usage",
    );
  const route = upstreamRoute(db, leader);
  const label = ESCALATE_KINDS[input.kind];
  const detail = escalationDetail({
    leader,
    kind: input.kind,
    label,
    note: input.note,
    task,
    forward,
    route,
  });
  const event = atomically(db, () => {
    const published = inbox.publish({
      subscriber: route.subscriber,
      taskId: task?.id,
      source: "leader",
      kind: "escalated",
      key:
        forward?.key ?? `${leader}:escalate:${input.kind}:${task?.ref ?? now}`,
      actor: leader,
      detail,
    });
    if (forward && forward.acked_at === null) inbox.ack([forward.id]);
    return published;
  });
  if (task)
    noteTask(
      db,
      task.id,
      "escalated",
      { ...detail, to: route.subscriber },
      now,
    );
  return {
    event: event.id,
    from: leader,
    to: route.subscriber,
    why: route.why,
    kind: input.kind,
    kind_label: label,
    task: task?.ref ?? null,
    forwarded: forward?.id ?? null,
  };
}

/** leader 登记与上交（atrium leader …）。权限：登记只有用户；leader 令牌只能改自己的备忘、替自己上交（guard.ts）。 */
export function registerLeaderRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  inbox: EventInbox,
) {
  ensureLeaderTables(db);
  app.get("/api/leaders", () => listLeaders(db));
  app.get("/api/leaders/:id", (request) => showLeader(db, id(request.params)));
  app.post("/api/leaders", { bodyLimit: 16 * 1024 }, (request, reply) =>
    reply.code(201).send(addLeader(db, request.body)),
  );
  app.patch("/api/leaders/:id", { bodyLimit: 16 * 1024 }, (request) => {
    // leader 自己改备忘（guard 已限定只改自己的备忘）：和 memo edit 一样按分身分段或合并（t275）。
    const clone = cloneOf(request);
    const body = request.body as { memo?: unknown } | null;
    if (!clone || body?.memo === undefined)
      return editLeader(db, id(request.params), request.body);
    const who = leaderRef(requireLeader(db, id(request.params)).id);
    writeMemoTo(
      db,
      who,
      memoText(body.memo, `atrium memo show --as ${who}`),
      memoTarget({
        label: clone.clone.label,
        started: clone.clone.started,
        siblings: clone.siblings.length,
      }),
    );
    return showLeader(db, who);
  });
  app.post("/api/leaders/:id/escalate", { bodyLimit: 16 * 1024 }, (request) =>
    escalate(db, inbox, id(request.params), request.body),
  );
}
