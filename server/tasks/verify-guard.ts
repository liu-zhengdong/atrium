import type { FastifyInstance, FastifyRequest } from "fastify";
import { Problem } from "../problem.ts";
import {
  VERIFIER_HEADER,
  verifierRef,
  verifierVerdict,
} from "./verify-scope.ts";

/**
 * 上线验证执行者的服务端校验（t239）：请求体解析后按 verify-scope.ts 的纯函数判定，止损类写接口一律拒绝。
 * 认出的验证任务短号记在请求上，停止事件据此记发起者。
 */

const verifiers = new WeakMap<FastifyRequest, string>();

/** 这次请求是不是上线验证执行者发来的：是则返回它的 tN（认不出为空串），否则 undefined。 */
export const verifierOf = (request: FastifyRequest) => verifiers.get(request);

export function registerVerifierGuard(app: FastifyInstance) {
  app.addHook("preHandler", async (request) => {
    const self = verifierRef(request.headers[VERIFIER_HEADER]);
    if (self === undefined) return;
    verifiers.set(request, self);
    const denied = verifierVerdict({
      method: request.method,
      route: request.routeOptions.url ?? "",
      id: (request.params as { id?: string } | undefined)?.id,
      body: request.body,
      self,
    });
    if (denied) throw new Problem(403, denied, "verifier_scope");
  });
}
