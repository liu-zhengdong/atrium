import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { leaderOf } from "../leaders/guard.ts";
import { SECRETARY } from "../leaders/route.ts";
import type { EventInbox } from "../tasks/events.ts";
import {
  announceChoice,
  choiceBrief,
  choiceLeader,
  publishChoice,
} from "./notify.ts";
import {
  addChoice,
  addComment,
  decideChoice,
  deciderSetting,
  ensureChoiceTables,
  getChoice,
  listChoices,
  parseLimit,
  setDecider,
  type Choice,
  type Decided,
} from "./store.ts";

/**
 * 选项单的接口（atrium choice …、atrium product set）。
 * 建：秘书、产品部（leader 令牌只能挂在自己负责的部分或它的上一层）；看：都能看；
 * 写意见：秘书与范围内的 leader；拍板（pick / pass）：用户始终可以（用户令牌或本机全景网页同源会话），
 * 节点设了下放时该节点的 leader 也可以（store 判）。谁拍板只由用户设（PUT /api/product/nodes/:id）。
 * 事件：建好后项目 leader 收 choice_review（写意见）；拍板人是用户时秘书收 choice_ready（叫醒），
 * 下放时 leader 收 choice_ready、秘书只收知会 choice_notice；拍板后同一去重键改投知会 choice_decided。
 */

type Q = Record<string, string | undefined>;
const q = (value: unknown) => (value ?? {}) as Q;
const id = (request: FastifyRequest) => (request.params as { id: string }).id;

export function registerChoiceRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  inbox: EventInbox,
  /** 拍板建了任务之后（t275）：运行时先给每件派规划任务，结果交 leader 采纳。 */
  onPicked?: (tasks: string[]) => void,
) {
  ensureChoiceTables(db);
  const leaderFor = (choice: Choice) => choiceLeader(db, choice);
  const publish = (
    subscriber: string,
    kind: string,
    choice: Choice,
    actor: string | undefined,
    detail: Record<string, unknown>,
  ) => publishChoice(inbox, subscriber, kind, choice, actor, detail);

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
  const decide = (action: "pick" | "pass") => (request: FastifyRequest) => {
    const actor = leaderOf(request) ?? "u1";
    const result: Decided = decideChoice(
      db,
      id(request),
      action,
      request.body,
      actor,
    );
    const detail = {
      decided_by: actor,
      tasks: result.tasks.map((t) => t.ref),
      decisions: result.decisions.map((d) => d.ref),
      note: result.choice.note,
    };
    publish(
      SECRETARY,
      "choice_decided",
      result.choice,
      actor === "u1" ? undefined : actor,
      detail,
    );
    // 拍板人自己也收：把它那条待办（choice_review / choice_ready）改成知会。
    const leader = leaderFor(result.choice);
    if (leader)
      publish(leader, "choice_decided", result.choice, undefined, detail);
    if (result.tasks.length) onPicked?.(result.tasks.map((t) => t.ref));
    return result;
  };
  app.post("/api/choices/:id/pick", { bodyLimit: 8 * 1024 }, decide("pick"));
  app.post("/api/choices/:id/pass", { bodyLimit: 8 * 1024 }, decide("pass"));
  app.get("/api/product/nodes/:id", (request) =>
    deciderSetting(db, id(request)),
  );
  app.put("/api/product/nodes/:id", { bodyLimit: 4 * 1024 }, (request) =>
    setDecider(db, id(request), request.body),
  );
}
