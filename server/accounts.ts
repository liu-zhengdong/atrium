import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  AccountFiles,
  lockedAuth,
  providerName,
  type Credential,
  type Mode,
  type Row,
} from "./account-files.ts";
import { AccountCatalog } from "./account-catalog.ts";
import { AccountLogin } from "./account-login.ts";
import { repairAccountFiles } from "./account-repair.ts";
import { AccountRefresh } from "./account-refresh.ts";
import { AccountWorker } from "./account-worker-client.ts";
import { Problem, type Store } from "./store.ts";
export {
  modePlan,
  shouldRefresh,
  shouldRecover,
  type AuthFile,
  type Mode,
} from "./account-files.ts";

export class Accounts {
  readonly root: string;
  private files: AccountFiles;
  private catalog: AccountCatalog;
  private refreshService: AccountRefresh;
  private loginService: AccountLogin;
  private knownSecrets = new Set<string>();
  constructor(
    private store: Store,
    data: string,
  ) {
    this.files = new AccountFiles(store, join(data, "accounts"));
    this.catalog = new AccountCatalog(store);
    this.root = this.files.root;
    const worker = new AccountWorker(this.files);
    this.refreshService = new AccountRefresh(store, this.files, worker);
    this.loginService = new AccountLogin(store, this.files, worker);
    repairAccountFiles(store, this.files, this.catalog, (value) =>
      this.remember(value),
    );
  }
  credentialMode(id: string) {
    return this.catalog.credentialMode(id);
  }
  list() {
    return this.catalog.list();
  }
  private remember(value: Credential) {
    for (const secret of value.type === "api_key"
      ? [value.key]
      : [value.access, value.refresh])
      if (secret) this.knownSecrets.add(secret);
  }
  redact(_agentId: string, text: string) {
    for (const secret of this.knownSecrets)
      text = text.replaceAll(secret, "[凭据已隐藏]");
    return text;
  }
  private load(row: Row) {
    return this.files.load(row);
  }
  private save(row: Row, value: Credential) {
    try {
      this.remember(this.load(row));
    } catch {
      /* first save or damaged original */
    }
    this.remember(value);
    this.files.save(row, value);
  }
  add(provider: string, name: string, key: string) {
    provider = providerName.parse(provider);
    if (!key) throw new Problem(400, "API key 不能为空");
    const number = Number(
      this.store.transaction(() =>
        this.store.run(
          "INSERT INTO accounts(provider,name,type) VALUES(?,?,'api_key')",
          provider,
          name,
        ),
      ).lastInsertRowid,
    );
    try {
      this.save(this.catalog.row(number), { type: "api_key", key });
    } catch {
      this.store.run("DELETE FROM accounts WHERE number=?", number);
      throw new Problem(500, "账号保存失败");
    }
    return { id: `k${number}` };
  }
  rename(ref: string, name: string) {
    return this.catalog.rename(ref, name);
  }
  switchMode(id: string): {
    mode: Mode;
    assigned: { provider: string; account: string }[];
  };
  switchMode(
    id: string,
    target: Mode,
  ): { mode: Mode; preserved: string | null };
  switchMode(id: string, target?: Mode) {
    this.store.agent(id);
    if (!target)
      return {
        mode: this.catalog.mode(id),
        assigned: this.store
          .all<{ provider: string; number: number }>(
            `SELECT x.provider,a.number FROM account_assignments x JOIN accounts a ON a.number=x.account_number WHERE x.agent_id=?`,
            id,
          )
          .map((r) => ({ provider: r.provider, account: `k${r.number}` })),
      };
    const entries = Object.fromEntries(
      this.store
        .all<{ account_number: number }>(
          "SELECT account_number FROM account_assignments WHERE agent_id=?",
          id,
        )
        .map(({ account_number }) => {
          const row = this.catalog.row(account_number);
          return [row.provider, this.load(row)];
        }),
    );
    return this.files.prepareMode(id, target, entries, this.catalog.mode(id));
  }
  assign(id: string, ref: string) {
    const agent = this.store.agent(id),
      row = this.catalog.row(this.catalog.number(ref));
    if (
      row.provider === "antigravity" &&
      !existsSync(join(this.files.dir(row.number), "antigravity-accounts.json"))
    )
      throw new Problem(409, "此 Antigravity 账号缺少附带状态，暂不支持分配");
    if (
      this.store.one(
        "SELECT 1 FROM account_assignments WHERE agent_id=? AND provider=?",
        id,
        row.provider,
      )
    )
      throw new Problem(409, "该身份已有此 provider 的账号，请先撤销");
    if (!agent.agent_directory)
      throw new Problem(409, "身份没有配置目录，请先启动身份");
    let preserved: string | null = null;
    if (this.catalog.mode(id) === "shared")
      preserved = this.files.prepareMode(
        id,
        "assigned",
        { [row.provider]: this.load(row) },
        this.catalog.mode(id),
      ).preserved;
    else
      lockedAuth(agent.agent_directory, (data) => ({
        ...data,
        [row.provider]: this.load(row),
      }));
    this.store.run(
      "INSERT INTO account_assignments(agent_id,provider,account_number) VALUES(?,?,?)",
      id,
      row.provider,
      row.number,
    );
    this.files.sidecar(row, agent.agent_directory);
    return { mode: "assigned", account: ref, preserved };
  }
  unassign(id: string, provider: string) {
    const agent = this.store.agent(id);
    provider = providerName.parse(provider);
    if (
      !this.store.one(
        "SELECT 1 FROM account_assignments WHERE agent_id=? AND provider=?",
        id,
        provider,
      )
    )
      throw new Problem(404, "分配不存在");
    if (!agent.agent_directory) throw new Problem(409, "身份没有配置目录");
    if (this.catalog.mode(id) === "assigned") {
      lockedAuth(agent.agent_directory, (data) => {
        delete data[provider];
        return data;
      });
      if (provider === "antigravity")
        rmSync(join(agent.agent_directory, "antigravity-accounts.json"), {
          force: true,
        });
    }
    this.store.run(
      "DELETE FROM account_assignments WHERE agent_id=? AND provider=?",
      id,
      provider,
    );
    return { unassigned: true };
  }
  remove(ref: string) {
    const number = this.catalog.number(ref),
      row = this.catalog.row(number);
    for (const a of this.catalog.assigned(number))
      this.unassign(a.agent_id, row.provider);
    this.store.run("DELETE FROM accounts WHERE number=?", number);
    rmSync(this.files.dir(number), { recursive: true, force: true });
    return { removed: true };
  }
  refresh() {
    return this.refreshService.refresh();
  }
  start() {
    this.refreshService.start();
  }
  close() {
    return this.refreshService.close();
  }
  login(provider: string, name: string) {
    return this.loginService.login(provider, name);
  }
  loginEvents(ref: string, after: number) {
    return this.loginService.loginEvents(this.catalog.number(ref), after);
  }
  answer(ref: string, value: string | null) {
    return this.loginService.answer(this.catalog.number(ref), value);
  }
  cancel(ref: string) {
    return this.loginService.cancel(this.catalog.number(ref));
  }
}
