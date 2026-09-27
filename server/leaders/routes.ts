import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { getTask, noteTask } from "../tasks/ledger.ts";
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
import { upstreamRoute } from "./subscriber.ts";
import { ESCALATE_KINDS, escalateInput } from "./wake.ts";

const id = (params: unknown) => String((params as { id?: string }).id ?? "");

/** leader 上交：生成一条投给上一层 leader（或秘书）的「要处理」事件，任务上也记一笔。 */
export function escalate(
  db: DatabaseSync,
  inbox: EventInbox,
  reference: string,
  body: unknown,
  now = Date.now(),
) {
  const leader = leaderRef(requireLeader(db, reference).id);
  const input = escalateInput(body);
  const task = input.task ? getTask(db, input.task) : null;
  const route = upstreamRoute(db, leader);
  const label = ESCALATE_KINDS[input.kind];
  const detail = {
    title: `${leader} 上交：${label}${task ? ` · ${task.title}` : ""}`.slice(
      0,
      200,
    ),
    from: leader,
    kind: input.kind,
    kind_label: label,
    reason: input.note,
    task: task?.ref ?? null,
    pr_url: task?.pr_url ?? null,
    routed: { to: route.subscriber, why: route.why },
  };
  const event = inbox.publish({
    subscriber: route.subscriber,
    taskId: task?.id,
    source: "leader",
    kind: "escalated",
    key: `${leader}:escalate:${input.kind}:${task?.ref ?? now}`,
    actor: leader,
    detail,
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
  app.patch("/api/leaders/:id", { bodyLimit: 16 * 1024 }, (request) =>
    editLeader(db, id(request.params), request.body),
  );
  app.post("/api/leaders/:id/escalate", { bodyLimit: 16 * 1024 }, (request) =>
    escalate(db, inbox, id(request.params), request.body),
  );
}
