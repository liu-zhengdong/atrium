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
