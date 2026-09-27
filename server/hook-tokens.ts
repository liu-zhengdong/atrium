import { createHash } from "node:crypto";
import { sameSecret } from "../shared/secret.ts";
import type { Store } from "./store.ts";
import { Problem } from "./problem.ts";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** 旧运行时：每个身份的消息箱推送令牌（只存摘要），随身份删除级联清掉。 */
export class HookTokens {
  constructor(private store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS inbox_tokens (
      agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL);`);
  }
  validHook(agentId: string, token: string) {
    if (!/^[a-f0-9]{64}$/.test(token)) return false;
    const row = this.store.one<{ token_hash: string }>(
      "SELECT token_hash FROM inbox_tokens WHERE agent_id=?",
      agentId,
    );
    return !!row && sameSecret(digest(token), row.token_hash);
  }
  setHook(agentId: string, tokenHash: string | null) {
    if (tokenHash && !/^[a-f0-9]{64}$/.test(tokenHash))
      throw new Problem(400, "推送令牌摘要无效");
    this.store.agent(agentId);
    if (tokenHash)
      this.store.run(
        "INSERT INTO inbox_tokens(agent_id,token_hash) VALUES(?,?) ON CONFLICT(agent_id) DO UPDATE SET token_hash=excluded.token_hash",
        agentId,
        tokenHash,
      );
    else this.store.run("DELETE FROM inbox_tokens WHERE agent_id=?", agentId);
  }
  hookHash(agentId: string) {
    return (
      this.store.one<{ token_hash: string }>(
        "SELECT token_hash FROM inbox_tokens WHERE agent_id=?",
        agentId,
      )?.token_hash ?? null
    );
  }
}
