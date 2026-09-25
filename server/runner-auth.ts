import { createHash } from "node:crypto";
import { sameSecret } from "../shared/secret.ts";
import type { Store } from "./store.ts";
import { Problem } from "./problem.ts";

const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");
type Credential = {
  runner_number: number;
  credential_number: number;
  token_hash: string;
  state: string;
  revoked_at: number | null;
};

/** Machine identity only. #168 owns machine-to-agent assignment and connection fencing. */
export class RunnerAuth {
  private fenceListeners = new Set<
    (runnerId: string, credentialIds: string[]) => void
  >();
  constructor(
    private store: Store,
    onFenced?: (runnerId: string, credentialIds: string[]) => void,
  ) {
    if (onFenced) this.listenFencing(onFenced);
    store.db.exec(`CREATE TABLE IF NOT EXISTS runners (
      number INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      created_at INTEGER NOT NULL, revoked_at INTEGER);
      CREATE TABLE IF NOT EXISTS runner_credentials (
      number INTEGER PRIMARY KEY AUTOINCREMENT,
      runner_number INTEGER NOT NULL REFERENCES runners(number) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK(state IN ('active','pending','revoked')),
      created_at INTEGER NOT NULL, revoked_at INTEGER);
      CREATE INDEX IF NOT EXISTS runner_credentials_runner ON runner_credentials(runner_number,state);`);
  }

  /** Subscribe after app creation too: admin routes and WS must share this instance. */
  listenFencing(listener: (runnerId: string, credentialIds: string[]) => void) {
    this.fenceListeners.add(listener);
    return () => this.fenceListeners.delete(listener);
  }
  private fence(runnerId: string, credentialIds: string[]) {
    for (const listener of this.fenceListeners)
      listener(runnerId, credentialIds);
  }
  list() {
    return this.store.all<{
      runnerId: string;
      name: string;
      state: string;
      pending: number;
    }>(`SELECT 'r'||r.number AS runnerId,r.name,
        CASE WHEN r.revoked_at IS NOT NULL THEN 'revoked' ELSE 'active' END AS state,
        EXISTS(SELECT 1 FROM runner_credentials c WHERE c.runner_number=r.number AND c.state='pending') AS pending
        FROM runners r ORDER BY r.number`);
  }
  private runnerNumber(runnerId: string) {
    if (!/^r[1-9][0-9]*$/.test(runnerId))
      throw new Problem(400, "运行器编号应为 r1 等短号", "usage");
    const number = Number(runnerId.slice(1));
    if (!Number.isSafeInteger(number))
      throw new Problem(400, "运行器编号过大", "usage");
    const row = this.store.one<{ revoked_at: number | null }>(
      "SELECT revoked_at FROM runners WHERE number=?",
      number,
    );
    if (!row) throw new Problem(404, "运行器不存在", "not_found");
    if (row.revoked_at !== null)
      throw new Problem(409, "运行器凭据已撤销", "conflict");
    return number;
  }
  issue(name: string, tokenHash: string) {
    if (!name.trim() || name.length > 100)
      throw new Problem(400, "运行器名称须为 1–100 字", "usage");
    this.validateHash(tokenHash);
    return this.store.transaction(() => {
      const runner = this.store.run(
        "INSERT INTO runners(name,created_at) VALUES(?,?)",
        name.trim(),
        Date.now(),
      );
      const number = Number(runner.lastInsertRowid);
      const credential = this.store.run(
        "INSERT INTO runner_credentials(runner_number,token_hash,state,created_at) VALUES(?,?,'active',?)",
        number,
        tokenHash,
        Date.now(),
      );
      return {
        runnerId: `r${number}`,
        credentialId: `rc${credential.lastInsertRowid}`,
      };
    });
  }
  rotate(runnerId: string, tokenHash: string) {
    const number = this.runnerNumber(runnerId);
    this.validateHash(tokenHash);
    return this.store.transaction(() => {
      this.store.run(
        "UPDATE runner_credentials SET state='revoked',revoked_at=? WHERE runner_number=? AND state='pending'",
        Date.now(),
        number,
      );
      const credential = this.store.run(
        "INSERT INTO runner_credentials(runner_number,token_hash,state,created_at) VALUES(?,?,'pending',?)",
        number,
        tokenHash,
        Date.now(),
      );
      return {
        runnerId,
        credentialId: `rc${credential.lastInsertRowid}`,
        pending: true,
      };
    });
  }
  revoke(runnerId: string) {
    const number = this.runnerNumber(runnerId);
    const active = this.store.all<{ number: number }>(
      "SELECT number FROM runner_credentials WHERE runner_number=? AND state='active'",
      number,
    );
    this.store.transaction(() => {
      this.store.run(
        "UPDATE runners SET revoked_at=? WHERE number=?",
        Date.now(),
        number,
      );
      this.store.run(
        "UPDATE runner_credentials SET state='revoked',revoked_at=? WHERE runner_number=? AND state!='revoked'",
        Date.now(),
        number,
      );
    });
    this.fence(
      runnerId,
      active.map((row) => `rc${row.number}`),
    );
  }
  /** Pass the entire Authorization header; return machine identity, never an agent grant. */
  authenticateRunner(authorization: string | undefined) {
    const token = /^Bearer ([a-f0-9]{64})$/i.exec(authorization ?? "")?.[1];
    if (!token) throw new Problem(401, "运行器认证失败", "auth_required");
    const tokenHash = digest(token);
    const row = this.store.one<Credential>(
      `SELECT c.number AS credential_number,c.runner_number,c.token_hash,c.state,r.revoked_at
       FROM runner_credentials c JOIN runners r ON r.number=c.runner_number
       WHERE c.token_hash=?`,
      tokenHash,
    );
    if (
      !row ||
      row.revoked_at !== null ||
      row.state === "revoked" ||
      !sameSecret(tokenHash, row.token_hash)
    )
      throw new Problem(401, "运行器认证失败", "auth_required");
    const runnerId = `r${row.runner_number}`;
    const credentialId = `rc${row.credential_number}`;
    if (row.state === "pending") {
      const retired = this.store.transaction(() => {
        const active = this.store.all<{ number: number }>(
          "SELECT number FROM runner_credentials WHERE runner_number=? AND state='active'",
          row.runner_number,
        );
        this.store.run(
          "UPDATE runner_credentials SET state='revoked',revoked_at=? WHERE runner_number=? AND state='active'",
          Date.now(),
          row.runner_number,
        );
        this.store.run(
          "UPDATE runner_credentials SET state='active' WHERE number=? AND state='pending'",
          row.credential_number,
        );
        return active.map((entry) => `rc${entry.number}`);
      });
      this.fence(runnerId, retired);
    }
    return { runnerId, credentialId };
  }
  /** Check before every machine command; an old WS cannot survive rotation or revocation. */
  validRunnerCredential(runnerId: string, credentialId: string): boolean {
    if (
      !/^r[1-9][0-9]*$/.test(runnerId) ||
      !/^rc[1-9][0-9]*$/.test(credentialId)
    )
      return false;
    const runnerNumber = Number(runnerId.slice(1));
    const credentialNumber = Number(credentialId.slice(2));
    if (
      !Number.isSafeInteger(runnerNumber) ||
      !Number.isSafeInteger(credentialNumber)
    )
      return false;
    const row = this.store.one<{ active: number }>(
      `SELECT 1 AS active FROM runner_credentials c JOIN runners r ON r.number=c.runner_number
       WHERE r.number=? AND c.number=? AND r.revoked_at IS NULL AND c.state='active'`,
      runnerNumber,
      credentialNumber,
    );
    return !!row;
  }
  private validateHash(value: string) {
    if (!/^[a-f0-9]{64}$/.test(value))
      throw new Problem(400, "令牌摘要无效", "usage");
  }
}
