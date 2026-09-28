import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { leaderOf } from "../leaders/guard.ts";
import { SECRETARY } from "../leaders/route.ts";
import { partRoute } from "../leaders/subscriber.ts";
import { nodeByAddress } from "../org/model.ts";
import type { EventInbox } from "../tasks/events.ts";
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

const brief = (choice: Choice) => ({
  choice: choice.ref,
  title: choice.title,
  node: choice.node,
  node_name: choice.node_name,
  options: choice.options.length,
  status: choice.status,
  decider: choice.decider,
});

export function registerChoiceRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  inbox: EventInbox,
) {
  ensureChoiceTables(db);
  /** 选项单所在节点最近的 leader；没有为 null。 */
  const leaderFor = (choice: Choice) => {
    const subscriber = partRoute(
      db,
      nodeByAddress(db, choice.node).id,
    ).subscriber;
    return subscriber === SECRETARY ? null : subscriber;
  };
  const publish = (
    subscriber: string,
    kind: string,
    choice: Choice,
    actor: string | undefined,
    detail: Record<string, unknown>,
  ) =>
    inbox.publish({
      subscriber,
      source: "choice",
      kind,
      key: `choice:${choice.ref}`,
      actor,
      detail: { ...brief(choice), ...detail },
    });

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
    const leader = leaderFor(choice);
    const show = `atrium choice show ${choice.ref}`;
    if (choice.decider === "u1") {
      publish(SECRETARY, "choice_ready", choice, creator, {
        task: choice.task,
        hint: `${choice.node_name}有一份新的选项单等用户拍板：${show}；可以和别的产品部的选项合并、去重后一起递给用户，但不删改方向；用户在全景网页或 atrium choice pick ${choice.ref} 选项号 里拍板`,
      });
      if (leader && leader !== creator)
        publish(leader, "choice_review", choice, creator, {
          hint: `${choice.node_name}有一份新的选项单，拍板人是用户；先看 ${show}，可以写意见、补依据、标倾向：atrium choice comment ${choice.ref} 意见 --prefer 选项号 --basis 依据；不能拍板`,
        });
    } else {
      if (choice.decider !== creator)
        publish(choice.decider, "choice_ready", choice, creator, {
          hint: `${choice.node_name}的选项单由你拍板（${choice.decider_why}）：先看 ${show}，再 atrium choice pick ${choice.ref} 选项号 --note 说明，或 atrium choice pass ${choice.ref} --note 原因`,
        });
      publish(SECRETARY, "choice_notice", choice, creator, {
        hint: `${choice.node_name}有一份新的选项单，拍板权已下放给 ${choice.decider}，只需知会用户：${show}`,
      });
    }
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
          ...brief(choice),
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
