import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { defaultTemplate } from "./profile.ts";
import { Problem, type Store } from "./store.ts";

const require = createRequire(import.meta.url);
const credential = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("api_key"), key: z.string().min(1) })
    .passthrough(),
  z
    .object({
      type: z.literal("oauth"),
      access: z.string(),
      refresh: z.string(),
      expires: z.number(),
    })
    .passthrough(),
]);
type Credential = z.infer<typeof credential>;
export type Mode = "shared" | "assigned";
export type AuthFile = "missing" | "link" | "empty" | "content";
export type ModePlan =
  "unchanged" | "link" | "write" | "backup-link" | "backup-write";
export const modePlan = (
  current: AuthFile,
  target: Mode,
  already: Mode,
): ModePlan => {
  if (current === "content")
    return target === "shared"
      ? "backup-link"
      : already === "assigned"
        ? "unchanged"
        : "backup-write";
  if (target === "assigned")
    return current === "link"
      ? "write"
      : already === "assigned" && current === "empty"
        ? "unchanged"
        : "write";
  return current === "link" ? "unchanged" : "link";
};
export const shouldRefresh = (expires: number | null, now: number) =>
  expires !== null && expires - now < 30 * 60_000;
export const shouldRecover = (
  identity: Credential | undefined,
  stored: Credential,
) =>
  identity?.type === "oauth" &&
  stored.type === "oauth" &&
  identity.expires > stored.expires;

type Row = {
  number: number;
  provider: string;
  name: string;
  type: "oauth" | "api_key";
  expires: number | null;
  status: string;
  last_error: string | null;
};
type Assignment = {
  agent_id: string;
  provider: string;
  account_number: number;
  agent_directory: string | null;
};
const providerName = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const authFile = (directory: string) => join(directory, "auth.json");
function fileState(file: string): AuthFile {
  if (!existsSync(file) && !lstatExists(file)) return "missing";
  if (lstatSync(file).isSymbolicLink()) return "link";
  try {
    const text = readFileSync(file, "utf8").trim();
    if (!text || !Object.keys(JSON.parse(text) as object).length)
      return "empty";
  } catch {
    /* preserve unreadable original */
  }
  return "content";
}
function lstatExists(file: string) {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}
function readAuth(file: string): Record<string, Credential> {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Problem(409, "凭据文件无法读取，未覆盖");
  return parsed as Record<string, Credential>;
}
function privateWrite(file: string, value: unknown) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temp, file);
    chmodSync(file, 0o600);
  } finally {
    rmSync(temp, { force: true });
  }
}
function lockedAuth(
  directory: string,
  change: (data: Record<string, Credential>) => Record<string, Credential>,
) {
  const file = authFile(directory);
  if (fileState(file) === "link")
    throw new Problem(409, "分配目标仍是共享软链，未写入");
  if (!existsSync(file)) privateWrite(file, {});
  const release = lockfile.lockSync(file, { realpath: false });
  try {
    privateWrite(file, change(readAuth(file)));
  } finally {
    release();
  }
}
function backup(file: string): string {
  const dest = `${file}.preserved-${randomUUID()}`;
  renameSync(file, dest);
  return dest;
}
function safeError() {
  return "Provider 刷新失败；请重新登录或检查 provider 状态";
}

export class Accounts {
  private timer?: NodeJS.Timeout;
  private refreshing = false;
  private running?: Promise<void>;
  private workers = new Set<ChildProcess>();
  private knownSecrets = new Set<string>();
  private jobs = new Map<
    number,
    {
      child: ChildProcess;
      events: unknown[];
      prompt?: { id: string; type: string };
      done: boolean;
    }
  >();
  constructor(
    private store: Store,
    private data: string,
  ) {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    chmodSync(this.root, 0o700);
    for (const row of store.all<Row>("SELECT * FROM accounts")) {
      try {
        this.remember(this.load(row));
      } catch {
        /* damaged accounts remain isolated */
      }
    }
  }
  get root() {
    return join(this.data, "accounts");
  }
  private dir(number: number) {
    return join(this.root, `k${number}`);
  }
  private row(number: number) {
    const row = this.store.one<Row>(
      "SELECT * FROM accounts WHERE number=?",
      number,
    );
    if (!row) throw new Problem(404, "账号不存在");
    return row;
  }
  private number(ref: string) {
    if (!/^k[1-9]\d{0,14}$/.test(ref)) throw new Problem(404, "账号不存在");
    return this.row(Number(ref.slice(1))).number;
  }
  private assigned(number: number) {
    return this.store.all<Assignment>(
      `SELECT x.*,a.agent_directory FROM account_assignments x
      JOIN agents a ON a.id=x.agent_id WHERE x.account_number=? AND a.deleted_at IS NULL`,
      number,
    );
  }
  private mode(id: string): Mode {
    return (
      this.store.one<{ mode: Mode }>(
        "SELECT mode FROM credential_modes WHERE agent_id=?",
        id,
      )?.mode ?? "shared"
    );
  }
  credentialMode(id: string) {
    return this.mode(this.store.agent(id).id);
  }
  list() {
    return this.store
      .all<Row>("SELECT * FROM accounts ORDER BY number")
      .map((r) => ({
        id: `k${r.number}`,
        provider: r.provider,
        name: r.name,
        type: r.type,
        expires: r.expires,
        status: r.status,
        last_error: r.last_error,
        assigned: this.assigned(r.number).map(
          (a) => this.store.agent(a.agent_id).ref,
        ),
      }));
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
  private load(row: Row): Credential {
    return credential.parse(
      readAuth(authFile(this.dir(row.number)))[row.provider],
    );
  }
  private save(row: Row, value: Credential) {
    try {
      this.remember(this.load(row));
    } catch {
      /* first save or a damaged original */
    }
    this.remember(value);
    const dir = this.dir(row.number);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    privateWrite(authFile(dir), { [row.provider]: value });
    this.store.run(
      "UPDATE accounts SET expires=?,status='ready',last_error=NULL WHERE number=?",
      value.type === "oauth" ? value.expires : null,
      row.number,
    );
  }
  add(provider: string, name: string, key: string) {
    provider = providerName.parse(provider);
    if (!key) throw new Problem(400, "API key 不能为空");
    const row = this.store.transaction(() =>
      this.store.run(
        "INSERT INTO accounts(provider,name,type) VALUES(?,?,'api_key')",
        provider,
        name,
      ),
    );
    const number = Number(row.lastInsertRowid);
    const result = this.row(number);
    try {
      this.save(result, { type: "api_key", key });
    } catch {
      this.store.run("DELETE FROM accounts WHERE number=?", number);
      throw new Problem(500, "账号保存失败");
    }
    return { id: `k${number}` };
  }
  rename(ref: string, name: string) {
    this.store.run(
      "UPDATE accounts SET name=? WHERE number=?",
      name,
      this.number(ref),
    );
    return { renamed: true };
  }
  private prepareMode(
    id: string,
    target: Mode,
    entries: Record<string, Credential>,
  ) {
    const agent = this.store.agent(id);
    if (!agent.agent_directory)
      throw new Problem(409, "身份没有配置目录，请先启动身份");
    const directory = agent.agent_directory,
      file = authFile(directory);
    const plan = modePlan(fileState(file), target, this.mode(id));
    let preserved: string | undefined;
    if (target === "assigned" && fileState(file) === "link") {
      this.store.run(
        `INSERT INTO credential_modes(agent_id,mode,shared_target) VALUES(?,'shared',?)
        ON CONFLICT(agent_id) DO UPDATE SET shared_target=excluded.shared_target`,
        id,
        readlinkSync(file),
      );
    }
    if (plan.startsWith("backup")) preserved = backup(file);
    if (plan === "write" || plan === "backup-write") {
      if (lstatExists(file)) rmSync(file);
      privateWrite(file, entries);
    } else if (plan === "link" || plan === "backup-link") {
      if (lstatExists(file)) rmSync(file);
      const saved = this.store.one<{ shared_target: string }>(
        "SELECT shared_target FROM credential_modes WHERE agent_id=?",
        id,
      )?.shared_target;
      symlinkSync(saved ?? authFile(defaultTemplate()), file);
    }
    this.store.run(
      `INSERT INTO credential_modes(agent_id,mode) VALUES(?,?)
      ON CONFLICT(agent_id) DO UPDATE SET mode=excluded.mode`,
      id,
      target,
    );
    return { mode: target, preserved: preserved ?? null };
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
        mode: this.mode(id),
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
          const row = this.row(account_number);
          return [row.provider, this.load(row)];
        }),
    );
    return this.prepareMode(id, target, entries);
  }
  assign(id: string, ref: string) {
    const agent = this.store.agent(id),
      row = this.row(this.number(ref));
    if (
      row.provider === "antigravity" &&
      !existsSync(join(this.dir(row.number), "antigravity-accounts.json"))
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
    // A first assignment changes mode and replaces only the identity's own file.
    let preserved: string | null = null;
    if (this.mode(id) === "shared")
      preserved = this.prepareMode(id, "assigned", {
        [row.provider]: this.load(row),
      }).preserved;
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
    this.sidecar(row, agent.agent_directory);
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
    if (this.mode(id) === "assigned") {
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
    const number = this.number(ref),
      row = this.row(number);
    for (const assignment of this.assigned(number))
      this.unassign(assignment.agent_id, row.provider);
    this.store.run("DELETE FROM accounts WHERE number=?", number);
    rmSync(this.dir(number), { recursive: true, force: true });
    return { removed: true };
  }
  private sidecar(row: Row, directory: string) {
    if (row.provider !== "antigravity") return;
    const source = join(this.dir(row.number), "antigravity-accounts.json");
    const dest = join(directory, "antigravity-accounts.json");
    if (existsSync(source))
      privateWrite(dest, JSON.parse(readFileSync(source, "utf8")));
  }
  private distribute(row: Row) {
    const value = this.load(row);
    let failures = 0;
    for (const a of this.assigned(row.number)) {
      if (!a.agent_directory || this.mode(a.agent_id) !== "assigned") continue;
      try {
        lockedAuth(a.agent_directory, (data) => ({
          ...data,
          [row.provider]: value,
        }));
        this.sidecar(row, a.agent_directory);
      } catch {
        // Keep the unreadable identity file intact; other identities can still receive the refresh.
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
    let latest = this.load(row);
    let sidecar: unknown;
    for (const a of this.assigned(row.number)) {
      if (
        !a.agent_directory ||
        this.mode(a.agent_id) !== "assigned" ||
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
        /* isolate a damaged identity, don't erase its original */
      }
    }
    if (shouldRecover(latest, this.load(row))) {
      this.save(row, latest);
      if (sidecar !== undefined)
        privateWrite(
          join(this.dir(row.number), "antigravity-accounts.json"),
          sidecar,
        );
      this.distribute(row);
    }
  }
  private runWorker(
    row: Row,
    operation: "refresh" | "login",
    onMessage?: (message: any) => void,
  ) {
    return new Promise<void>((resolve, reject) => {
      const child = fork(
        new URL("./account-worker.mjs", import.meta.url),
        [this.dir(row.number), row.provider, operation],
        {
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          execArgv: [],
          env: { ...process.env, PI_CODING_AGENT_DIR: this.dir(row.number) },
        },
      );
      this.workers.add(child);
      const timer = setTimeout(
        () => child.kill(),
        operation === "login" ? 5 * 60_000 : 30_000,
      );
      let done = false;
      child.on("message", (message: any) => {
        if (message?.kind === "done") done = true;
        onMessage?.(message);
      });
      child.once("error", () => {
        this.workers.delete(child);
        clearTimeout(timer);
        reject(new Error(safeError()));
      });
      child.once("exit", (code) => {
        this.workers.delete(child);
        clearTimeout(timer);
        done && code === 0 ? resolve() : reject(new Error(safeError()));
      });
      if (operation === "login") onMessage?.({ kind: "child", child });
    });
  }
  async refresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      for (const row of this.store.all<Row>(
        "SELECT * FROM accounts WHERE type='oauth' ORDER BY number",
      )) {
        try {
          this.recover(row);
          const latest = this.row(row.number);
          if (!shouldRefresh(latest.expires, Date.now())) continue;
          await this.runWorker(latest, "refresh");
          const updated = this.load(latest);
          this.store.run(
            "UPDATE accounts SET expires=?,status='ready',last_error=NULL WHERE number=?",
            updated.type === "oauth" ? updated.expires : null,
            row.number,
          );
          this.distribute(latest);
        } catch {
          this.store.run(
            "UPDATE accounts SET status='error',last_error=? WHERE number=?",
            safeError(),
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
    for (const child of this.workers) child.kill();
    await this.running;
  }
  login(provider: string, name: string) {
    provider = providerName.parse(provider);
    if (!["openai-codex", "antigravity"].includes(provider))
      throw new Problem(400, "此 provider 暂不支持账号库 OAuth 登录");
    const number = Number(
      this.store.run(
        "INSERT INTO accounts(provider,name,type,status) VALUES(?,?,'oauth','pending')",
        provider,
        name,
      ).lastInsertRowid,
    );
    const row = this.row(number),
      directory = this.dir(number);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    privateWrite(authFile(directory), {});
    if (provider === "antigravity") {
      let path: string;
      try {
        path = require.resolve("pi-antigravity/package.json", {
          paths: [join(defaultTemplate(), "npm")],
        });
      } catch {
        this.store.run("DELETE FROM accounts WHERE number=?", number);
        throw new Problem(400, "未安装 pi-antigravity，暂不支持分配");
      }
      privateWrite(join(directory, "settings.json"), {
        packages: [path.replace(/\/package\.json$/, "")],
      });
    }
    const job: {
      child: ChildProcess;
      events: unknown[];
      prompt?: { id: string; type: string };
      done: boolean;
    } = { child: null as unknown as ChildProcess, events: [], done: false };
    this.jobs.set(number, job);
    void this.runWorker(row, "login", (message) => {
      if (message.kind === "child") job.child = message.child;
      else if (message.kind === "notify") job.events.push(message.event);
      else if (message.kind === "prompt") {
        job.prompt = { id: message.id, type: message.prompt.type };
        job.events.push({ prompt: message.prompt });
      }
    })
      .then(() => {
        const value = this.load(row);
        this.store.run(
          "UPDATE accounts SET status='ready',expires=? WHERE number=?",
          value.type === "oauth" ? value.expires : null,
          number,
        );
        job.done = true;
      })
      .catch(() => {
        this.store.run(
          "UPDATE accounts SET status='error',last_error=? WHERE number=?",
          "登录未完成",
          number,
        );
        job.done = true;
      });
    return { id: `k${number}` };
  }
  loginEvents(ref: string, after: number) {
    const number = this.number(ref),
      job = this.jobs.get(number);
    if (!job)
      return {
        events: [],
        next: after,
        done: true,
        status: this.row(number).status,
      };
    const events = job.events.slice(after);
    return {
      events,
      next: job.events.length,
      done: job.done,
      status: this.row(number).status,
    };
  }
  answer(ref: string, value: string | null) {
    const job = this.jobs.get(this.number(ref));
    if (!job || !job.prompt || job.done)
      throw new Problem(409, "没有待回答的登录请求");
    job.child.send({ id: job.prompt.id, value });
    job.prompt = undefined;
    return { accepted: true };
  }
  cancel(ref: string) {
    const job = this.jobs.get(this.number(ref));
    job?.child.kill();
    return { cancelled: true };
  }
}
