import {
  AccountFiles,
  authFile,
  credential,
  fileState,
  lockedAuth,
  readAuth,
  type Credential,
  type Row,
} from "./account-files.ts";
import { AccountCatalog } from "./account-catalog.ts";
import type { Store } from "./store.ts";

// Isolate only the broken record, keeping original bytes beside the file and never logging contents.
export function repairAccountFiles(
  store: Store,
  files: AccountFiles,
  catalog: AccountCatalog,
  remember: (value: Credential) => void,
) {
  store.run(`DELETE FROM account_assignments WHERE agent_id NOT IN
    (SELECT id FROM agents WHERE deleted_at IS NULL)`);
  const stale = store.all<{
    agent_id: string;
  }>(`SELECT agent_id FROM credential_modes WHERE agent_id NOT IN
    (SELECT id FROM agents WHERE deleted_at IS NULL)`);
  for (const item of stale)
    console.error(`已删除身份的凭据模式已清理：${item.agent_id}`);
  store.run(`DELETE FROM credential_modes WHERE agent_id NOT IN
    (SELECT id FROM agents WHERE deleted_at IS NULL)`);
  for (const row of store.all<Row>("SELECT * FROM accounts")) {
    // OAuth login writes an empty placeholder before authorization. Cancellation or
    // a service restart is not a corrupt credential and must not be quarantined.
    if (
      row.type === "oauth" &&
      (row.status === "pending" || row.status === "error") &&
      fileState(authFile(files.dir(row.number))) === "empty"
    ) {
      if (
        row.status === "pending" ||
        row.last_error === "账号凭据损坏，原文件已隔离"
      )
        store.run(
          "UPDATE accounts SET status='error',last_error=? WHERE number=?",
          "登录未完成",
          row.number,
        );
      continue;
    }
    try {
      remember(files.load(row));
    } catch {
      const file = authFile(files.dir(row.number));
      if (fileState(file) === "content")
        files.quarantine(file, `账号 k${row.number} 损坏`);
      store.run(
        "UPDATE accounts SET status='error',last_error=? WHERE number=?",
        "账号凭据损坏，原文件已隔离",
        row.number,
      );
      console.error(`账号 k${row.number} 凭据无法读取；其他账号继续运行`);
    }
  }
  const identities = store.all<{
    agent_id: string;
    agent_directory: string | null;
  }>(`SELECT m.agent_id,a.agent_directory FROM credential_modes m
    JOIN agents a ON a.id=m.agent_id WHERE m.mode='assigned' AND a.deleted_at IS NULL`);
  for (const identity of identities) {
    if (!identity.agent_directory) continue;
    const file = authFile(identity.agent_directory);
    if (fileState(file) === "link") {
      console.error(`身份 ${identity.agent_id} 的分配凭据仍为软链；未覆盖`);
      continue;
    }
    try {
      const data = readAuth(file);
      for (const value of Object.values(data)) credential.parse(value);
    } catch {
      if (fileState(file) === "content")
        files.quarantine(file, `身份 ${identity.agent_id} 损坏`);
      const entries: Record<string, Credential> = {};
      for (const a of store.all<{ provider: string; account_number: number }>(
        "SELECT provider,account_number FROM account_assignments WHERE agent_id=?",
        identity.agent_id,
      )) {
        try {
          entries[a.provider] = files.load(catalog.row(a.account_number));
        } catch {
          /* damaged account was already isolated */
        }
      }
      lockedAuth(identity.agent_directory, () => entries);
      store.run(
        `UPDATE accounts SET status='error',last_error=? WHERE number IN
        (SELECT account_number FROM account_assignments WHERE agent_id=?)`,
        "身份凭据损坏，原文件已隔离",
        identity.agent_id,
      );
      console.error(`身份 ${identity.agent_id} 凭据已隔离并从可读账号恢复`);
    }
  }
}
