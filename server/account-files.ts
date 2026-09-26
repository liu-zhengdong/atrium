import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import lockfile from "proper-lockfile";
import { defaultTemplate } from "./profile.ts";
import { Problem, type Store } from "./store.ts";

export const credential = z.discriminatedUnion("type", [
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
export type Credential = z.infer<typeof credential>;
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

export type Row = {
  number: number;
  provider: string;
  name: string;
  type: "oauth" | "api_key" | "local" | "setup_token";
  expires: number | null;
  status: string;
  last_error: string | null;
  credential_updated_at?: number | null;
};
export type Assignment = {
  agent_id: string;
  provider: string;
  account_number: number;
  agent_directory: string | null;
};
export const providerName = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const authFile = (directory: string) => join(directory, "auth.json");
export function lstatExists(file: string) {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}
export function fileState(file: string): AuthFile {
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
export function readAuth(file: string): Record<string, Credential> {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Problem(409, "凭据文件无法读取，未覆盖");
  return parsed as Record<string, Credential>;
}
export function privateWrite(file: string, value: unknown) {
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
export function lockedAuth(
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
export function backup(file: string): string {
  const dest = `${file}.preserved-${randomUUID()}`;
  renameSync(file, dest);
  return dest;
}

export class AccountFiles {
  constructor(
    private store: Store,
    readonly root: string,
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
  }
  dir(number: number) {
    return join(this.root, `k${number}`);
  }
  load(row: Row): Credential {
    return credential.parse(
      readAuth(authFile(this.dir(row.number)))[row.provider],
    );
  }
  save(row: Row, value: Credential) {
    const dir = this.dir(row.number);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    privateWrite(authFile(dir), { [row.provider]: value });
    this.store.run(
      "UPDATE accounts SET expires=?,status='ready',last_error=NULL WHERE number=?",
      value.type === "oauth" ? value.expires : null,
      row.number,
    );
  }
  prepareMode(
    id: string,
    target: Mode,
    entries: Record<string, Credential>,
    previous: Mode,
  ) {
    const agent = this.store.agent(id);
    if (!agent.agent_directory)
      throw new Problem(409, "身份没有配置目录，请先启动身份");
    const file = authFile(agent.agent_directory);
    const plan = modePlan(fileState(file), target, previous);
    let preserved: string | undefined;
    if (target === "assigned" && fileState(file) === "link")
      this.store.run(
        `INSERT INTO credential_modes(agent_id,mode,shared_target) VALUES(?,'shared',?)
        ON CONFLICT(agent_id) DO UPDATE SET shared_target=excluded.shared_target`,
        id,
        readlinkSync(file),
      );
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
  sidecar(row: Row, directory: string) {
    if (row.provider !== "antigravity") return;
    const source = join(this.dir(row.number), "antigravity-accounts.json");
    if (existsSync(source))
      privateWrite(
        join(directory, "antigravity-accounts.json"),
        JSON.parse(readFileSync(source, "utf8")),
      );
  }
  // Quarantine only owned, ordinary files. Never rename a shared Pi template symlink.
  quarantine(file: string, reason: string) {
    const preserved = backup(file);
    console.error(`账号凭据隔离：${reason}；原文件已保留在 ${preserved}`);
    return preserved;
  }
}
