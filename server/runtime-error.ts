import { RequestError } from "@agentclientprotocol/sdk";
import { Problem } from "./problem.ts";

/** ACP's RequestError.toString() drops JSON-RPC data, including diagnostic details. */
export function bridgeReadinessProblem(error: unknown): Problem | undefined {
  if (!/独立令牌就绪检查未获肯定回应/.test(errorWithDetails(error)))
    return undefined;
  return new Problem(
    409,
    "独立令牌就绪检查未获肯定回应，已拒绝启动。请将此身份 settings.json 的 claude-bridge 引用钉到新版提交，再执行 PI_CODING_AGENT_DIR=<身份目录> pi update 并重启身份",
    "launch_secret_unsupported",
  );
}

export function isAuthOrCapabilityFailure(error: unknown): boolean {
  if (error instanceof Problem && error.code === "launch_secret_unsupported")
    return true;
  return /独立令牌就绪检查未获肯定回应|\b(?:401|403|unauthoriz\w*|forbidden|not logged in|authentication required|invalid[_ .-]*(?:api[_ .-]*)?key)\b/i.test(
    errorWithDetails(error),
  );
}

export function errorWithDetails(error: unknown): string {
  const message = String(error);
  if (!(error instanceof RequestError) || error.data === undefined)
    return message;
  try {
    return `${message}\ndata: ${JSON.stringify(error.data)}`;
  } catch {
    return `${message}\ndata: [无法序列化]`;
  }
}

/**
 * 正常模型输出：assistant 文本，或模型发起的工具调用。
 * 轨迹里 kind/name 的全部取值（pi-atrium 的 src/runtime/extension.ts 产生）：
 * - run_start / run_end / session / delivery / gap：回合与连接生命周期，不算；
 * - tool_start：模型发起工具调用，算；
 * - tool_end：工具结果，不是模型输出，不算；
 * - message + name=assistant 且非 error：assistant 文本，算；
 * - message + name=user：Pi 侧的输入，不算；
 * - message + error：失败或中断本身，不算；
 * - 只有思考的消息：扩展不落轨迹（text 为空、stopReason 正常），不会出现。
 */
export function normalModelOutput(event: {
  kind: string;
  name?: string;
  error?: boolean;
}): boolean {
  return (
    event.kind === "tool_start" ||
    (event.kind === "message" && event.name === "assistant" && !event.error)
  );
}

/** 事件排在故障之后：比较轨迹入库行号，不比较时钟。 */
export function afterFailure(
  traceId: number | null,
  watermark: number | null,
): boolean {
  return traceId !== null && watermark !== null && traceId > watermark;
}
