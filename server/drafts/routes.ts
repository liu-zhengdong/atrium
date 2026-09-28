import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { resolveActor } from "../actor.ts";
import { Problem } from "../problem.ts";
import type { Exec } from "../tasks/git.ts";
import type { TaskRunner } from "../tasks/runner.ts";
import { repoMaterials } from "./materials.ts";
import {
  applyDraft,
  createDraftTask,
  draftInput,
  ensureDraftTables,
} from "./store.ts";

type Q = Record<string, string | undefined>;

/**
 * 全景初稿（atrium map draft / apply）：起草与写入只给用户（leader 规则表没登记，默认拒绝）。
 * 起草先由运行时读好材料（只读、跳过凭据），再建任务按 task run 同一条路派发。
 */
export function registerDraftRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  runner: TaskRunner,
  exec?: Exec,
) {
  ensureDraftTables(db);
  app.post("/api/drafts", { bodyLimit: 4 * 1024 }, async (request, reply) => {
    const input = draftInput(request.body);
    const materials = await repoMaterials(input.repo, exec);
    const task = createDraftTask(db, materials, input.node);
    try {
      const launched = await runner.run(task.ref, { worker: input.worker });
      return reply.code(201).send({ repo: materials.repo, ...launched });
    } catch (error) {
      // 派不出去不删任务：原因给调用方，换个执行者再派。
      if (!(error instanceof Problem)) throw error;
      return reply.code(201).send({
        repo: materials.repo,
        task,
        run_error: error.message,
        next: `atrium task run ${task.ref} --worker 工具+模型`,
      });
    }
  });
  app.get("/api/drafts/:id", (request) => {
    const query = (request.query ?? {}) as Q;
    return applyDraft(
      db,
      (request.params as { id: string }).id,
      { dry_run: true, ...(query.node ? { node: query.node } : {}) },
      "u1",
    );
  });
  app.post("/api/drafts/:id/apply", { bodyLimit: 1024 }, (request) =>
    applyDraft(
      db,
      (request.params as { id: string }).id,
      request.body,
      resolveActor(db),
    ),
  );
}
