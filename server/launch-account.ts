import { Problem, type Store } from "./store.ts";
import { SETUP_PROVIDER } from "./setup-token-account.ts";

// An account number, never credential bytes, is handed to the target runner.
export function assignedSetupTokenRef(
  store: Store,
  identityId: string,
): string | undefined {
  const row = store.one<{
    number: number;
    type: string;
    status: string;
    last_error: string | null;
  }>(
    `SELECT a.number,a.type,a.status,a.last_error FROM accounts a
     JOIN account_assignments x ON x.account_number=a.number
     WHERE x.agent_id=? AND x.provider=?`,
    identityId,
    SETUP_PROVIDER,
  );
  if (row?.type !== "setup_token") return undefined;
  if (row.status !== "ready")
    throw new Problem(
      409,
      `账号 k${row.number} 不可用：${row.last_error ?? "请检查 setup-token"}`,
    );
  return `k${row.number}`;
}
