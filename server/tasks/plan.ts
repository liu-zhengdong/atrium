import { Problem } from "../problem.ts";
import { RISKS, TRUSTS, isRisk, type Risk, type Trust } from "./profiles.ts";
import { transition, type TaskStatus } from "./state.ts";

/**
 * 派活计划（#262）：全部是纯函数，不碰进程、文件和数据库。
 * 请求校验 → 能否受理（状态、是否已在跑/排队）→ 档案风险上限 → 立即拉起还是排队。
 */

export type RunRequest = { worker?: string; risk?: Risk; urgent?: boolean };

export function runRequest(body: unknown): RunRequest {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body))
    throw new Problem(400, "请求体应为 JSON 对象", "usage");
  const input = body as Record<string, unknown>;
  const extra = Object.keys(input).filter(
    (key) => key !== "worker" && key !== "risk" && key !== "urgent",
  );
  if (extra.length)
    throw new Problem(
      400,
      `不认识的字段：${extra.join("、")}；可用 worker、risk、urgent`,
      "usage",
    );
  if (input.urgent !== undefined && typeof input.urgent !== "boolean")
    throw new Problem(400, "urgent: 应为 true 或 false", "usage");
  const text = (key: string) => {
    const value = input[key];
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string")
      throw new Problem(400, `${key}: 应为文本`, "usage");
    return value.trim();
  };
  const risk = text("risk");
  if (risk !== undefined && !isRisk(risk))
    throw new Problem(400, `risk: 只能是 ${RISKS.join("、")}`, "usage");
  return {
    worker: text("worker"),
    risk,
    ...(input.urgent === true ? { urgent: true } : {}),
  };
}

export type Admission = {
  status: TaskStatus;
  /** 服务正持有它的进程，或正在准备拉起。 */
  running: boolean;
  queued: boolean;
};

/** 能否受理一次 run；拒绝时给出 409 的中文原因。 */
export function admit(
  input: Admission,
): { ok: true } | { ok: false; reason: string } {
  if (input.running)
    return { ok: false, reason: "正在运行或正在启动，不能重复派" };
  if (input.queued) return { ok: false, reason: "已在排队" };
  const next = transition(input.status, { kind: "start" });
  return next.ok ? { ok: true } : { ok: false, reason: next.reason };
}

/** 档案 max_risk 低于任务 risk 时返回拒绝原因。 */
export function riskRefusal(
  workerId: string,
  maxRisk: Risk | undefined,
  risk: Risk,
): string | undefined {
  if (!maxRisk || RISKS.indexOf(maxRisk) >= RISKS.indexOf(risk))
    return undefined;
  return `执行者 ${workerId} 的档案 max_risk=${maxRisk}，接不了 risk=${risk} 的任务；换执行者或降低 --risk`;
}

/** 额度换人时还要核对信任等级；缺失的档案按 unknown 处理。 */
export function trustRefusal(
  workerId: string,
  trust: Trust | undefined,
  risk: Risk,
) {
  const actual = trust ?? "unknown";
  if (TRUSTS.indexOf(actual) > RISKS.indexOf(risk)) return undefined;
  return `执行者 ${workerId} 的档案 trust=${actual}，接不了 risk=${risk} 的额度重派任务`;
}

/** 独占工具正忙就排队，否则立即拉起。 */
export function placement(
  exclusive: boolean,
  busy: boolean,
): "queue" | "launch" {
  return exclusive && busy ? "queue" : "launch";
}
