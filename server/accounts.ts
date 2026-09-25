import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  AccountFiles,
  lockedAuth,
  lstatExists,
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
import { ProviderDirectory } from "./provider-directory.ts";
import { validateKey, validationReason } from "./account-validation.ts";
import { defaultTemplate, readIdentityModel } from "./profile.ts";
import { seedModelsStore } from "./model.ts";
import {
  checkedCustom,
  CustomProviders,
  type CustomConfig,
} from "./custom-providers.ts";
import { setAccountModel } from "./account-models.ts";
import { Problem, type Store } from "./store.ts";
import { commandAgent } from "../shared/command-agent.ts";
import { UNASSIGNED } from "./assignment.ts";
import {
  readSetupToken,
  validateSetupToken,
  writeSetupToken,
  SETUP_PROVIDER,
} from "./setup-token-account.ts";
import {
  checkLocalLogin,
  LOCAL_NAME,
  LOCAL_PROVIDER,
} from "./local-account.ts";
export {
  modePlan,
  shouldRefresh,
  shouldRecover,
  type AuthFile,
  type Mode,
} from "./account-files.ts";

// A failed SQLite commit must also restore the exact on-disk credential state.
function restoreFileOnFailure(file: string) {
  const present = lstatExists(file);
  const link =
    present && lstatSync(file).isSymbolicLink() ? readlinkSync(file) : null;
  const bytes = present && link === null ? readFileSync(file) : null;
  return (preserved?: string | null) => {
    rmSync(file, { force: true });
    if (preserved) renameSync(preserved, file);
    else if (link !== null) symlinkSync(link, file);
    else if (bytes !== null) writeFileSync(file, bytes, { mode: 0o600 });
  };
}

export class Accounts {
  readonly root: string;
  private files: AccountFiles;
  private catalog: AccountCatalog;
  private refreshService: AccountRefresh;
  private loginService: AccountLogin;
  private providers: ProviderDirectory;
  private knownSecrets = new Set<string>();
  private worker: AccountWorker;
  private custom: CustomProviders;
  constructor(
    private store: Store,
    data: string,
  ) {
    this.files = new AccountFiles(store, join(data, "accounts"));
    this.custom = new CustomProviders(data);
    this.catalog = new AccountCatalog(store);
    this.root = this.files.root;
    const worker = new AccountWorker(this.files);
    this.worker = worker;
    this.refreshService = new AccountRefresh(store, this.files, worker);
    this.providers = new ProviderDirectory(worker);
    this.loginService = new AccountLogin(
      store,
      this.files,
      worker,
      this.providers,
    );
    repairAccountFiles(store, this.files, this.catalog, (value) =>
      this.remember(value),
    );
  }
  async providersList() {
    const builtIn = await this.providers.list();
    return [
      ...builtIn.filter((entry) => entry.id !== LOCAL_PROVIDER),
      {
        id: LOCAL_PROVIDER,
        name: LOCAL_NAME,
        methods: ["local" as const, "setup_token" as const],
        packagePath: null,
      },
      ...Object.keys(this.custom.all()).map((id) => ({
        id,
        name: id,
        methods: ["api_key" as const],
        packagePath: null,
      })),
    ];
  }
  customConfig(id: string) {
    return this.custom.get(id) ?? null;
  }
  async customModels(config: CustomConfig, key: string) {
    const clean = checkedCustom("custom", {
      ...config,
      models: config.models.length ? config.models : [{ id: "placeholder" }],
    });
    const response = await fetch(`${clean.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${key || "atrium-local"}` },
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.text();
    if (!response.ok)
      throw new Problem(
        400,
        body.replaceAll(key || "atrium-local", "[凭据已隐藏]").slice(0, 600),
      );
    const json = JSON.parse(body) as { data?: { id: string }[] };
    return {
      models: (json.data ?? [])
        .map((item) => item.id)
        .filter((id) => typeof id === "string"),
    };
  }
  preloadProviders() {
    void this.providers.list().catch((error: unknown) => {
      console.warn("供应商目录预加载失败：", error);
    });
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
  async probeKey(provider: string, key: string) {
    if (!key.trim()) throw new Problem(400, "API Key 不能为空");
    const custom = this.custom.get(provider);
    const entry = custom
      ? {
          id: provider,
          name: provider,
          packagePath: null,
          methods: ["api_key" as const],
        }
      : await this.providers.require(providerName.parse(provider), "api_key");
    const validation = await validateKey(this.worker, entry, key, custom);
    if (validation.status === "rejected")
      throw new Problem(
        400,
        `${entry.name} 拒绝了这个 API Key（${validationReason(validation.reason)}）`,
        "validation_failed",
      );
    return { ...validation, reason: validationReason(validation.reason) };
  }
  async addValidated(
    provider: string,
    name: string,
    key: string,
    allowUnverified = false,
    custom?: CustomConfig,
  ) {
    provider = providerName.parse(provider);
    if (!key && !custom) throw new Problem(400, "API key 不能为空");
    if (custom && !key) key = "atrium-local";
    const creatingCustom = !!custom;
    if (custom) {
      custom = checkedCustom(provider, custom);
      if (
        (await this.providers.list()).some((entry) => entry.id === provider) ||
        this.custom.get(provider)
      )
        throw new Problem(409, "供应商名称已存在");
    }
    custom ??= this.custom.get(provider) ?? undefined;
    const entry = custom
      ? {
          id: provider,
          name: provider,
          methods: ["api_key" as const],
          packagePath: null,
        }
      : await this.providers.require(provider, "api_key");
    const validation = await validateKey(this.worker, entry, key, custom);
    if (creatingCustom && validation.status !== "verified")
      throw new Problem(
        400,
        `服务返回 ${validationReason(validation.reason)}`,
        "validation_failed",
      );
    if (validation.status === "rejected")
      throw new Problem(
        400,
        `${entry.name} 拒绝了这个 API Key（${validationReason(validation.reason)}）`,
        "validation_failed",
      );
    if (validation.status === "unverified" && !allowUnverified)
      return { validation, id: null };
    const saved = this.add(provider, name, key);
    if (creatingCustom && custom) this.custom.save(provider, custom);
    if (validation.status !== "verified")
      this.store.run(
        "UPDATE accounts SET status='unverified',last_error=? WHERE number=?",
        validation.reason ?? "未校验",
        this.catalog.number(saved.id),
      );
    return { ...saved, validation };
  }
  addLocal(provider: string) {
    if (provider !== LOCAL_PROVIDER)
      throw new Problem(400, "该供应商不支持本机登录");
    const existing = this.store.one<{ number: number }>(
      "SELECT number FROM accounts WHERE provider=? AND type='local'",
      provider,
    );
    if (existing)
      throw new Problem(
        409,
        `本机登录账号 k${existing.number} 已存在；请使用 atrium assign <身份> k${existing.number}`,
      );
    const reason = checkLocalLogin(this.store);
    if (reason) throw new Problem(400, reason);
    const number = this.store.run(
      "INSERT INTO accounts(provider,name,type,status) VALUES(?,?,'local','ready')",
      provider,
      LOCAL_NAME,
    ).lastInsertRowid;
    return { id: `k${number}`, type: "local" as const };
  }
  async addSetupToken(
    name: string,
    token: string,
    validator: (value: string) => void | Promise<void> = validateSetupToken,
  ) {
    await validator(token);
    const number = this.store.run(
      "INSERT INTO accounts(provider,name,type,status,credential_updated_at) VALUES(?,?,'setup_token','ready',?)",
      SETUP_PROVIDER,
      name,
      Date.now(),
    ).lastInsertRowid;
    try {
      writeSetupToken(this.root, Number(number), token);
    } catch (error) {
      this.store.run("DELETE FROM accounts WHERE number=?", number);
      rmSync(this.files.dir(Number(number)), { recursive: true, force: true });
      throw error;
    }
    return { id: `k${number}`, type: "setup_token" as const };
  }
  async replaceSetupToken(
    ref: string,
    token: string,
    validator: (value: string) => void | Promise<void> = validateSetupToken,
    beforeSave: () => void = () => {},
  ) {
    const row = this.catalog.row(this.catalog.number(ref));
    if (row.type !== "setup_token")
      throw new Problem(400, "此账号不是 setup-token");
    await validator(token);
    // The account or its runtime may have changed while external validation ran.
    if (this.catalog.row(row.number).type !== "setup_token")
      throw new Problem(409, "账号已变更，请重新选择");
    beforeSave();
    writeSetupToken(this.root, row.number, token);
    this.store.run(
      "UPDATE accounts SET status='ready',last_error=NULL,credential_updated_at=? WHERE number=?",
      Date.now(),
      row.number,
    );
    return { replaced: true };
  }
  checkLocal(ref: string) {
    const row = this.catalog.row(this.catalog.number(ref));
    if (row.type !== "local") throw new Problem(400, "此账号不是本机登录");
    const reason = checkLocalLogin(this.store);
    this.store.run(
      "UPDATE accounts SET status=?,last_error=? WHERE number=?",
      reason ? "error" : "ready",
      reason,
      row.number,
    );
    return { id: ref, status: reason ? "error" : "ready", reason };
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
  async replaceKey(
    ref: string,
    key: string,
    allowUnverified = false,
    update?: CustomConfig,
  ) {
    const row = this.catalog.row(this.catalog.number(ref));
    if (row.type !== "api_key") throw new Problem(400, "此账号不是 API Key");
    if (!key && !this.custom.get(row.provider) && !update)
      throw new Problem(400, "API Key 不能为空");
    const custom = update
      ? checkedCustom(row.provider, update)
      : this.custom.get(row.provider);
    if (update && !this.custom.get(row.provider))
      throw new Problem(400, "不是自定义供应商");
    if (!key && custom)
      key = (this.load(row) as Extract<Credential, { type: "api_key" }>).key;
    const entry = custom
      ? {
          id: row.provider,
          name: row.provider,
          methods: ["api_key" as const],
          packagePath: null,
        }
      : await this.providers.require(row.provider, "api_key");
    const validation = await validateKey(this.worker, entry, key, custom);
    if (custom && validation.status !== "verified")
      throw new Problem(
        400,
        `服务返回 ${validationReason(validation.reason)}`,
        "validation_failed",
      );
    if (validation.status === "rejected")
      throw new Problem(
        400,
        `${entry.name} 拒绝了这个 API Key（${validationReason(validation.reason)}）`,
        "validation_failed",
      );
    if (validation.status === "unverified" && !allowUnverified)
      return { validation, updated: false };
    this.save(row, { type: "api_key", key });
    if (update) this.custom.save(row.provider, custom!);
    for (const assignment of this.catalog.assigned(row.number)) {
      if (
        assignment.agent_directory &&
        this.catalog.mode(assignment.agent_id) === "assigned"
      ) {
        lockedAuth(assignment.agent_directory, (data) => ({
          ...data,
          [row.provider]: { type: "api_key", key },
        }));
        if (custom)
          setAccountModel(assignment.agent_directory, row.provider, custom);
      }
    }
    this.store.run(
      "UPDATE accounts SET status=?, last_error=? WHERE number=?",
      validation.status === "verified" ? "ready" : "unverified",
      validation.status === "verified" ? null : (validation.reason ?? "未校验"),
      row.number,
    );
    if (validation.status === "verified")
      for (const assignment of this.catalog.assigned(row.number))
        if (
          this.store.failure(assignment.agent_id)?.text ===
          "模型认证失败，请更换 API Key"
        )
          this.store.clearFailure(assignment.agent_id);
    return { validation, updated: true };
  }
  markModelAuthFailure(agent: string, detail: string) {
    if (
      !/\b(401|403)\b|unauthoriz|forbidden|invalid.api.key|invalid_key|not logged in|authentication required/i.test(
        detail,
      )
    )
      return;
    const provider = this.store.agent(agent).agent_directory;
    const selected = provider
      ? readIdentityModel(provider)?.provider
      : undefined;
    if (!selected) return;
    const assigned = this.store.one<Row>(
      `SELECT a.* FROM accounts a JOIN account_assignments x ON x.account_number=a.number
       WHERE x.agent_id=? AND x.provider=?`,
      agent,
      selected,
    );
    if (!assigned) return;
    this.store.run(
      "UPDATE accounts SET status='error',last_error=? WHERE number=?",
      assigned.type === "setup_token"
        ? "Claude setup-token 失效；请更换账号令牌"
        : "模型认证失败，请更换 API Key",
      assigned.number,
    );
  }
  rename(ref: string, name: string) {
    return this.catalog.rename(ref, name);
  }
  private assignedEntries(id: string) {
    return Object.fromEntries(
      this.store
        .all<{ account_number: number }>(
          "SELECT account_number FROM account_assignments WHERE agent_id=?",
          id,
        )
        .flatMap(({ account_number }) => {
          const row = this.catalog.row(account_number);
          return row.type === "local" || row.type === "setup_token"
            ? []
            : [[row.provider, this.load(row)]];
        }),
    );
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
    if (target === "shared")
      throw new Problem(
        409,
        "共享个人 Pi 登录已停用；请用 atrium assign <身份> <账号短号> 分配账号",
      );
    return this.files.prepareMode(
      id,
      target,
      this.assignedEntries(id),
      this.catalog.mode(id),
    );
  }
  assign(id: string, ref: string, replace = false) {
    const agent = this.store.agent(id),
      row = this.catalog.row(this.catalog.number(ref));
    const previous = this.store.one<{ account_number: number }>(
      "SELECT account_number FROM account_assignments WHERE agent_id=? AND provider=?",
      id,
      row.provider,
    );
    if (previous?.account_number === row.number)
      return {
        mode: "assigned",
        account: ref,
        preserved: null,
        alreadyAssigned: true,
      };
    if (previous && !replace)
      throw new Problem(
        409,
        `该身份已有此 provider 的其他账号，请先撤销`,
        "already_assigned",
        undefined,
        `atrium unassign ${commandAgent(agent.name, agent.ref)} ${row.provider}`,
      );
    if (replace && !previous) throw new Problem(409, "该身份没有可替换的账号");
    if (!agent.agent_directory)
      throw new Problem(409, "身份没有配置目录，请先启动身份");
    // 带上模板里这个供应商的模型目录缓存，没启动过的身份也能列/设模型。
    seedModelsStore(agent.agent_directory, row.provider, defaultTemplate());
    if (
      row.provider === "antigravity" &&
      !existsSync(join(this.files.dir(row.number), "antigravity-accounts.json"))
    )
      throw new Problem(409, "此 Antigravity 账号缺少附带状态，暂不支持分配");
    // Local login and setup-token credentials never enter auth.json.
    if (row.type === "local" || row.type === "setup_token") {
      if (row.type === "setup_token") {
        if (row.status !== "ready")
          throw new Problem(409, `账号 ${ref} 不可用`);
        readSetupToken(this.root, row.number);
      }
      if (row.type === "local") {
        const reason = checkLocalLogin(this.store, id);
        if (reason) throw new Problem(409, reason);
      }
      this.store.transaction(() => {
        this.store.run(
          "INSERT INTO credential_modes(agent_id,mode) VALUES(?,'assigned') ON CONFLICT(agent_id) DO UPDATE SET mode='assigned'",
          id,
        );
        this.store.run(
          previous
            ? "UPDATE account_assignments SET account_number=? WHERE agent_id=? AND provider=?"
            : "INSERT INTO account_assignments(account_number,agent_id,provider) VALUES(?,?,?)",
          row.number,
          id,
          row.provider,
        );
      });
      if (this.store.failure(id)?.text === UNASSIGNED)
        this.store.clearFailure(id);
      return { mode: "assigned", account: ref, preserved: null };
    }
    // Read and validate before touching either the identity file or assignment row.
    const value = this.load(row);
    const sidecar =
      row.provider === "antigravity"
        ? join(agent.agent_directory, "antigravity-accounts.json")
        : null;
    const restoreAuth = restoreFileOnFailure(
      join(agent.agent_directory, "auth.json"),
    );
    const custom = this.custom.get(row.provider);
    const restoreModels = custom
      ? restoreFileOnFailure(join(agent.agent_directory, "models.json"))
      : null;
    const restoreSidecar = sidecar ? restoreFileOnFailure(sidecar) : null;
    let preserved: string | null = null;
    try {
      this.store.transaction(() => {
        if (this.catalog.mode(id) === "shared")
          preserved = this.files.prepareMode(
            id,
            "assigned",
            { ...this.assignedEntries(id), [row.provider]: value },
            "shared",
          ).preserved;
        else
          lockedAuth(agent.agent_directory!, (data) => ({
            ...data,
            [row.provider]: value,
          }));
        this.files.sidecar(row, agent.agent_directory!);
        if (custom)
          setAccountModel(agent.agent_directory!, row.provider, custom);
        if (previous)
          this.store.run(
            "UPDATE account_assignments SET account_number=? WHERE agent_id=? AND provider=?",
            row.number,
            id,
            row.provider,
          );
        else
          this.store.run(
            "INSERT INTO account_assignments(agent_id,provider,account_number) VALUES(?,?,?)",
            id,
            row.provider,
            row.number,
          );
      });
    } catch (error) {
      restoreAuth(preserved);
      restoreSidecar?.();
      restoreModels?.();
      throw error;
    }
    if (this.store.failure(id)?.text === UNASSIGNED)
      this.store.clearFailure(id);
    if (
      sidecar &&
      !existsSync(join(this.files.dir(row.number), "antigravity-accounts.json"))
    )
      rmSync(sidecar, { force: true });
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
    const row = this.store.one<Row>(
      `SELECT a.* FROM accounts a JOIN account_assignments x ON x.account_number=a.number
       WHERE x.agent_id=? AND x.provider=?`,
      id,
      provider,
    );
    if (
      row?.type !== "local" &&
      row?.type !== "setup_token" &&
      this.catalog.mode(id) === "assigned"
    ) {
      lockedAuth(agent.agent_directory, (data) => {
        delete data[provider];
        return data;
      });
      if (this.custom.get(provider))
        setAccountModel(agent.agent_directory, provider);
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
    if (this.custom.get(row.provider)) this.custom.remove(row.provider);
    if (row.type !== "local")
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
  relogin(ref: string) {
    if (this.catalog.row(this.catalog.number(ref)).type === "local")
      throw new Problem(400, "本机登录请运行 claude auth login");
    if (this.catalog.row(this.catalog.number(ref)).type === "setup_token")
      throw new Problem(
        400,
        "setup-token 账号请用 atrium account replace-token 更新",
      );
    return this.loginService.relogin(this.catalog.number(ref), () =>
      this.refreshService.distributeAccount(
        this.catalog.row(this.catalog.number(ref)),
      ),
    );
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
