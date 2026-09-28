import type { ChildProcess } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { spawnSshTunnel, stopSshTunnel } from "../platform/index.ts";
import {
  quarantineHostConnection,
  tunnelHostRows,
  type HostRow,
} from "./model.ts";
import {
  retryDelay,
  sshConnection,
  type SshConnection,
} from "./tunnel-plan.ts";

type Entry = {
  child?: ChildProcess;
  timer?: NodeJS.Timeout;
  attempt: number;
  status: "连接中" | "运行中" | "等待重连";
  error: string | null;
};
export type TunnelStatus = { status: string; error: string | null };

/** SSH 子进程随服务生命周期管理；编辑/移除时只重启对应主机。 */
export class HostTunnels {
  private readonly entries = new Map<number, Entry>();
  private closed = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly spawn = spawnSshTunnel,
    private readonly stop = stopSshTunnel,
  ) {
    let after = 0;
    for (;;) {
      const page = tunnelHostRows(db, after);
      if (!page.length) break;
      for (const row of page) {
        try {
          sshConnection({
            ssh: row.ssh_target,
            key: row.ssh_key ?? undefined,
            tunnel: `${row.tunnel_local_port}:${row.tunnel_remote_port}`,
          });
          this.start(row);
        } catch {
          quarantineHostConnection(db, row);
          console.warn(
            `主机 h${row.id} 的 SSH 配置无效，已移到 host_tunnel_invalid；其余主机照常启动`,
          );
        }
      }
      after = page.at(-1)!.id;
    }
  }

  status(id: number): TunnelStatus | null {
    const entry = this.entries.get(id);
    return entry ? { status: entry.status, error: entry.error } : null;
  }

  refresh(row: HostRow) {
    this.remove(row.id);
    if (!this.closed && row.removed_at === null && row.ssh_target)
      this.start(row);
  }

  private start(row: HostRow) {
    if (
      !row.ssh_target ||
      row.tunnel_local_port === null ||
      row.tunnel_remote_port === null
    )
      return;
    const config: SshConnection = {
      target: row.ssh_target,
      key: row.ssh_key,
      localPort: row.tunnel_local_port,
      remotePort: row.tunnel_remote_port,
    };
    const entry: Entry = { attempt: 0, status: "连接中", error: null };
    this.entries.set(row.id, entry);
    const launch = () => {
      if (this.closed || this.entries.get(row.id) !== entry) return;
      entry.status = "连接中";
      let child: ChildProcess;
      try {
        child = this.spawn(config);
      } catch (error) {
        failed(error);
        return;
      }
      entry.child = child;
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-1000);
      });
      const started = Date.now();
      child.once("spawn", () => {
        if (this.entries.get(row.id) === entry) {
          entry.status = "运行中";
        }
      });
      let ended = false;
      const finish = (error?: unknown) => {
        if (ended) return;
        ended = true;
        entry.child = undefined;
        if (Date.now() - started > 60_000) entry.attempt = 0;
        failed(error ?? (stderr.trim() || "SSH 进程退出"));
      };
      child.once("error", finish);
      child.once("exit", (code, signal) =>
        finish(stderr.trim() || `SSH 退出（${code ?? signal ?? "未知"}）`),
      );
    };
    const failed = (error: unknown) => {
      if (this.closed || this.entries.get(row.id) !== entry) return;
      entry.error =
        error instanceof Error
          ? error.message.slice(0, 500)
          : String(error).slice(0, 500);
      entry.status = "等待重连";
      entry.timer = setTimeout(launch, retryDelay(entry.attempt++));
      entry.timer.unref();
    };
    launch();
  }

  remove(id: number) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.child) this.stop(entry.child);
  }

  close() {
    this.closed = true;
    for (const id of this.entries.keys()) this.remove(id);
  }
}
