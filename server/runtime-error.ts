import { RequestError } from "@agentclientprotocol/sdk";

/** ACP's RequestError.toString() drops JSON-RPC data, including diagnostic details. */
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
