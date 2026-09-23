import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./store.ts";
import {
  AccountFiles,
  authFile,
  credential,
  fileState,
  lockedAuth,
  privateWrite,
  readAuth,
  shouldRecover,
  shouldRefresh,
  type Assignment,
  type Row,
  type Mode,
} from "./account-files.ts";
import { AccountWorker } from "./account-worker-client.ts";

export class AccountRefresh {
  private timer?: NodeJS.Timeout;
  private refreshing = false;
  private running?: Promise<void>;
  constructor(
    private store: Store,
    private files: AccountFiles,
    private worker: Pick<AccountWorker, "run" | "close">,
  ) {}
  private assigned(number: number) {
    return this.store.all<Assignment>(
      `SELECT x.*,a.agent_directory FROM account_assignments x
      JOIN agents a ON a.id=x.agent_id WHERE x.account_number=? AND a.deleted_at IS NULL`,
      number,
    );
  }
  private active(id: string) {
    return (
      this.store.one<{ mode: Mode }>(
        "SELECT mode FROM credential_modes WHERE agent_id=?",
        id,
      )?.mode === "assigned"
    );
  }
  private distribute(row: Row) {
    const value = this.files.load(row);
    let failures = 0;
    for (const a of this.assigned(row.number)) {
      if (!a.agent_directory || !this.active(a.agent_id)) continue;
      try {
        lockedAuth(a.agent_directory, (data) => ({
          ...data,
          [row.provider]: value,
        }));
        this.files.sidecar(row, a.agent_directory);
      } catch {
        // Preserve the invalid original, but keep distributing to the other identities.
        failures++;
      }
    }
    if (failures)
      this.store.run(
        "UPDATE accounts SET status='error',last_error=? WHERE number=?",
        `${failures} 个身份的凭据文件未能更新，原文件已保留`,
        row.number,
      );
  }
  private recover(row: Row) {
    let latest = this.files.load(row);
    let sidecar: unknown;
    for (const a of this.assigned(row.number)) {
      if (
        !a.agent_directory ||
        !this.active(a.agent_id) ||
        fileState(authFile(a.agent_directory)) !== "content"
      )
        continue;
      try {
        const candidate = credential.parse(
          readAuth(authFile(a.agent_directory))[row.provider],
        );
        if (shouldRecover(candidate, latest)) {
          const path = join(a.agent_directory, "antigravity-accounts.json");
          sidecar =
            row.provider === "antigravity"
              ? JSON.parse(readFileSync(path, "utf8"))
              : undefined;
          latest = candidate;
        }
      } catch {
        /* damaged identities are handled by startup repair */
      }
    }
    if (shouldRecover(latest, this.files.load(row))) {
      this.files.save(row, latest);
      if (sidecar !== undefined)
        privateWrite(
          join(this.files.dir(row.number), "antigravity-accounts.json"),
          sidecar,
        );
      this.distribute(row);
    }
  }
  async refresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      for (const row of this.store.all<Row>(
        "SELECT * FROM accounts WHERE type='oauth' ORDER BY number",
      )) {
        if (row.last_error === "账号凭据损坏，原文件已隔离") continue;
        try {
          this.recover(row);
          const latest = this.store.one<Row>(
            "SELECT * FROM accounts WHERE number=?",
            row.number,
          )!;
          if (!shouldRefresh(latest.expires, Date.now())) continue;
          await this.worker.run(latest, "refresh");
          const updated = this.files.load(latest);
          this.store.run(
            "UPDATE accounts SET expires=?,status='ready',last_error=NULL WHERE number=?",
            updated.type === "oauth" ? updated.expires : null,
            row.number,
          );
          this.distribute(latest);
        } catch (error) {
          const reason =
            error instanceof Error && error.message.startsWith("账号凭据")
              ? error.message
              : error instanceof Error &&
                  [
                    "登录已失效，需要重新登录",
                    "网络或超时，稍后自动重试",
                    "Provider 插件加载失败",
                  ].includes(error.message)
                ? error.message
                : "未知错误";
          this.store.run(
            "UPDATE accounts SET status='error',last_error=? WHERE number=?",
            reason,
            row.number,
          );
        }
      }
    } finally {
      this.refreshing = false;
    }
  }
  start() {
    this.running = this.refresh();
    this.timer = setInterval(() => {
      this.running = this.refresh();
    }, 5 * 60_000);
    this.timer.unref();
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
    this.worker.close();
    await this.running;
  }
}
