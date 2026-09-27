import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { leaderOf } from "../leaders/guard.ts";
import { SECRETARY } from "../leaders/route.ts";
import type { EventInbox } from "../tasks/events.ts";
import {
  addChoice,
  decideChoice,
  ensureChoiceTables,
  getChoice,
  listChoices,
  parseLimit,
  type Choice,
  type Decided,
} from "./store.ts";

/**
 * 选项单的接口（atrium choice …）。建：秘书、产品部（leader 令牌只能挂在自己负责的部分或它的上一层）；
 * 看：都能看；拍板（pick / pass）只认用户：用户令牌或本机全景网页会话（auth-policy 的 map-write），
 * leader 令牌一律拒绝。建好投 choice_ready 叫醒秘书，拍板后同一去重键改投知会 choice_decided。
 */

type Q = Record<string, string | undefined>;
const q = (value: unknown) => (value ?? {}) as Q;
const id = (request: FastifyRequest) => (request.params as { id: string }).id;

const brief = (choice: Choice) => ({
  choice: choice.ref,
  title: choice.title,
  node: choice.node,
  node_name: choice.node_name,
  options: choice.options.length,
  status: choice.status,
});

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
    const leader = leaderOf(request);
    const choice = addChoice(db, request.body, leader ?? SECRETARY);
    inbox.publish({
      subscriber: SECRETARY,
      source: "choice",
      kind: "choice_ready",
      key: `choice:${choice.ref}`,
      actor: leader,
      detail: {
        ...brief(choice),
        task: choice.task,
        hint: `${choice.node_name}有一份新的选项单等用户拍板：atrium choice show ${choice.ref}；可以和别的产品部的选项合并、去重后一起递给用户，但不删改方向；用户在全景网页或 atrium choice pick ${choice.ref} 选项号 里拍板`,
      },
    });
    return reply.code(201).send(choice);
  });
  const decide = (action: "pick" | "pass") => (request: FastifyRequest) => {
    const result: Decided = decideChoice(db, id(request), action, request.body);
    inbox.publish({
      subscriber: SECRETARY,
      source: "choice",
      kind: "choice_decided",
      key: `choice:${result.choice.ref}`,
      detail: {
        ...brief(result.choice),
        tasks: result.tasks.map((t) => t.ref),
        decisions: result.decisions.map((d) => d.ref),
        note: result.choice.note,
      },
    });
    return result;
  };
  app.post("/api/choices/:id/pick", { bodyLimit: 8 * 1024 }, decide("pick"));
  app.post("/api/choices/:id/pass", { bodyLimit: 8 * 1024 }, decide("pass"));
}
