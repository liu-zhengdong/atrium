import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { leaderOf } from "../leaders/guard.ts";
import { SECRETARY } from "../leaders/route.ts";
import type { EventInbox } from "../tasks/events/events.ts";
import { announceChoice, choiceBrief, decideAndAnnounce } from "./notify.ts";
import {
  addChoice,
  addComment,
  ensureChoiceTables,
  getChoice,
  listChoices,
  parseLimit,
} from "./store.ts";

/**
 * 选项单的接口（atrium choice …）。
 * 建：秘书、leader（leader 令牌只能挂在自己负责的部门或它的上一层）、调研类周期任务（settle.ts）；看：都能看；
 * 写意见：秘书与范围内的 leader；拍板（pick / pass）只有用户（用户令牌或本机全景网页同源会话）。
 * 事件：建好后项目 leader 收 choice_review（写意见），秘书收 choice_ready（叫醒）；拍板后同一去重键改投知会 choice_decided。
 */

type Q = Record<string, string | undefined>;
const q = (value: unknown) => (value ?? {}) as Q;
const id = (request: FastifyRequest) => (request.params as { id: string }).id;

export function registerChoiceRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  inbox: EventInbox,
) {
  ensureChoiceTables(db);

  app.get("/api/choices", (request) => {
    const query = q(request.query);
    return listChoices(db, {
      node: query.node || undefined,
      open: query.open === "1" || query.open === "true",
      before: query.before,
      limit: parseLimit(query.limit),
    });
  });
  app.get("/api/choices/:id", (request) => getChoice(db, id(request)));
  app.post("/api/choices", { bodyLimit: 64 * 1024 }, (request, reply) => {
    const creator = leaderOf(request);
    const choice = addChoice(db, request.body, creator ?? SECRETARY);
    announceChoice(db, inbox, choice, creator);
    return reply.code(201).send(choice);
  });
  app.post(
    "/api/choices/:id/comment",
    { bodyLimit: 16 * 1024 },
    (request, reply) => {
      const by = leaderOf(request) ?? SECRETARY;
      const choice = addComment(db, id(request), request.body, by);
      inbox.publish({
        subscriber: SECRETARY,
        source: "choice",
        kind: "choice_comment",
        key: `choice-comment:${choice.ref}`,
        actor: by === SECRETARY ? undefined : by,
        detail: {
          ...choiceBrief(choice),
          by,
          comments: choice.comments.length,
          hint: `给用户递选项单时带上意见：atrium choice show ${choice.ref}`,
        },
      });
      return reply.code(201).send(choice);
    },
  );
  const decide = (action: "pick" | "pass") => (request: FastifyRequest) =>
    decideAndAnnounce(
      db,
      inbox,
      id(request),
      action,
      request.body,
      leaderOf(request) ?? "u1",
    );
  app.post("/api/choices/:id/pick", { bodyLimit: 8 * 1024 }, decide("pick"));
  app.post("/api/choices/:id/pass", { bodyLimit: 8 * 1024 }, decide("pass"));
}
