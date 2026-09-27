import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { resolveActor } from "../actor.ts";
import { ensureSkillTables } from "./schema.ts";
import {
  acceptProposal,
  addSkill,
  bindSkill,
  editSkill,
  listProposals,
  listSkills,
  rejectProposal,
  revertSkill,
  showProposal,
  showSkill,
  skillHistory,
  type AddSkillInput,
  type EditSkillInput,
} from "./store.ts";

type Query = Record<string, string | undefined>;
const q = (value: unknown) => (value ?? {}) as Query;
const params = (value: unknown) => (value ?? {}) as Record<string, string>;
const body = (value: unknown) => (value ?? {}) as Record<string, unknown>;
/** 技能文件合计 256 KB，JSON 转义后留足余量。 */
const FILES_BODY = 1024 * 1024;

/** 组织技能（#264 第 3b 步）：命令行 atrium skill 走这里；--as 与 org 相同，是 u1 或某个节点 leader。 */
export function registerSkillRoutes(app: FastifyInstance, db: DatabaseSync) {
  ensureSkillTables(db);
  const actor = (query: unknown) => resolveActor(db, q(query).as);
  app.get("/api/skills", (request) =>
    listSkills(db, q(request.query).archived === "1"),
  );
  app.get("/api/skills/:slug", (request) =>
    showSkill(db, params(request.params).slug!),
  );
  app.get("/api/skills/:slug/history", (request) => {
    const query = q(request.query);
    return skillHistory(db, params(request.params).slug!, {
      rev: query.rev,
      before: query.before,
      limit: query.limit === undefined ? undefined : Number(query.limit),
    });
  });
  app.post("/api/skills", { bodyLimit: FILES_BODY }, (request, reply) =>
    reply
      .code(201)
      .send(
        addSkill(db, body(request.body) as AddSkillInput, actor(request.query)),
      ),
  );
  app.put("/api/skills/:slug", { bodyLimit: FILES_BODY }, (request) =>
    editSkill(
      db,
      params(request.params).slug!,
      body(request.body) as EditSkillInput,
      actor(request.query),
    ),
  );
  app.post("/api/skills/:slug/revert", { bodyLimit: 8 * 1024 }, (request) => {
    const input = body(request.body);
    return revertSkill(
      db,
      params(request.params).slug!,
      input.to,
      input.reason,
      actor(request.query),
    );
  });
  app.post("/api/skills/:slug/bind", { bodyLimit: 8 * 1024 }, (request) =>
    bindSkill(
      db,
      params(request.params).slug!,
      String(body(request.body).node ?? ""),
      actor(request.query),
    ),
  );
  app.post("/api/skills/:slug/unbind", { bodyLimit: 8 * 1024 }, (request) =>
    bindSkill(
      db,
      params(request.params).slug!,
      String(body(request.body).node ?? ""),
      actor(request.query),
      true,
    ),
  );
  app.get("/api/skill-proposals", (request) => {
    const query = q(request.query);
    return listProposals(db, {
      status: query.status,
      limit: query.limit === undefined ? undefined : Number(query.limit),
    });
  });
  app.get("/api/skill-proposals/:id", (request) =>
    showProposal(db, params(request.params).id!),
  );
  app.post(
    "/api/skill-proposals/:id/accept",
    { bodyLimit: 8 * 1024 },
    (request) =>
      acceptProposal(
        db,
        params(request.params).id!,
        body(request.body).reason,
        actor(request.query),
      ),
  );
  app.post(
    "/api/skill-proposals/:id/reject",
    { bodyLimit: 8 * 1024 },
    (request) =>
      rejectProposal(
        db,
        params(request.params).id!,
        body(request.body).reason,
        actor(request.query),
      ),
  );
}
