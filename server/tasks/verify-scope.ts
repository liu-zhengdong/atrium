/**
 * 上线验证执行者的服务端边界（t239，纯函数，穷举测试）：验证执行者照 PR 的「端到端验证」在真实环境跑，
 * 不能借此停别人的活、改主机或服务状态（t233 照步骤跑了 host clean，把两台上 12 件在跑的活全停了）。
 * 命令行给真实服务发请求时带 VERIFIER_HEADER（值是验证任务自己的 tN），服务端按「路由 → 规则」拒绝止损类写接口；
 * 读接口与其他写接口照常。验证执行者自己起的隔离服务不带这个头，不受限。
 */

export const VERIFIER_HEADER = "x-atrium-verifier";

/** 头里的验证任务短号；不是 tN 的（旧命令行给 "1"）仍按验证执行者限制，只是认不出自己是哪件。 */
export function verifierRef(value: string | string[] | undefined) {
  const text = (Array.isArray(value) ? value[0] : value)?.trim();
  if (!text) return undefined;
  const match = /^t([1-9][0-9]{0,11})$/i.exec(text);
  return match ? `t${match[1]}` : "";
}

const taskNumber = (value: unknown) => {
  const match = /^t?([1-9][0-9]{0,11})$/i.exec(String(value ?? "").trim());
  return match ? Number(match[1]) : null;
};

const fieldsOf = (body: unknown): Record<string, unknown> =>
  body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};

const given = (value: unknown) =>
  value !== undefined && value !== null && value !== "";

export type VerifierRequest = {
  method: string;
  /** Fastify 匹配到的路由（如 /api/tasks/:id/stop），不是原始 URL。 */
  route: string;
  /** 路径参数 :id。 */
  id?: string;
  body?: unknown;
  /** 验证任务自己的 tN；认不出为空串。 */
  self: string;
};

/** 这次请求会做的止损类操作（人话）；不是止损类为 null。 */
export function stopgapAction(request: VerifierRequest): string | null {
  const verb = request.method.toUpperCase();
  if (verb === "GET" || verb === "HEAD") return null;
  const { route } = request;
  if (route.startsWith("/api/service/") || route === "/api/auth/rotate")
    return "启停、重启、升级服务或轮换令牌";
  if (route === "/api/hosts" || route.startsWith("/api/hosts/"))
    return "改执行机器的状态（host clean、登记、移除）";
  if (route === "/api/pause" || route === "/api/resume")
    return "暂停或恢复（atrium pause / resume）";
  const body = fieldsOf(request.body);
  if (route === "/api/tasks/:id/stop") {
    const target = taskNumber(request.id);
    return target !== null && target === taskNumber(request.self)
      ? null
      : `停别的任务 ${target === null ? String(request.id ?? "") : `t${target}`}`;
  }
  if (
    (route === "/api/tasks/:id" && verb === "PATCH") ||
    (route === "/api/tasks" && verb === "POST")
  ) {
    if (given(body.stopgap)) return "写止损动作（--stopgap）";
    if (body.urgent === true) return "标紧急（会抢占在跑的任务）";
    if (body.with_children === true) return "连带取消子任务（在跑的会先停掉）";
  }
  if (route === "/api/tasks/:id/run" && body.urgent === true)
    return "标紧急派活（会抢占在跑的任务）";
  return null;
}

/** 拒绝的回执：说清楚不能做什么、这一步怎么记、能去哪验证。 */
export const verifierDenied = (what: string) =>
  `验证任务不能做止损操作（${what}），这一步记 unverifiable（matched=null）并写明原因；能在隔离环境验证的，用临时 ATRIUM_DATA 与另一个 ATRIUM_PORT 起隔离服务、配假执行者去那里跑`;

/** 验证执行者这次请求的判定：放行为 null，拒绝为回执。 */
export function verifierVerdict(request: VerifierRequest): string | null {
  const what = stopgapAction(request);
  return what ? verifierDenied(what) : null;
}
