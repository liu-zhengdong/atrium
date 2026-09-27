import { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const packageRoot = fileURLToPath(new URL("../", import.meta.url));
// An installed update can replace package.json while the old service is alive.
// Keep the running process's version stable until its replacement starts.
const bootVersion = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.1.0";
  } catch {
    return "0.1.0";
  }
})();
export function currentVersion(): string {
  return bootVersion;
}
export function dataDirectory(env: NodeJS.ProcessEnv = process.env) {
  // Never keep mutable user data under an npm installation: npm update replaces it.
  const path = resolve(env.ATRIUM_DATA ?? join(homedir(), ".atrium"));
  return existsSync(path) ? realpathSync(path) : path;
}
/**
 * 前一代（聊天运行时）的默认数据目录（t71）：已归档，新一代不读不写、不在上面建表。
 * 没设 ATRIUM_DATA、新默认目录还没有而旧目录在时，提示一句，免得以为数据丢了。
 */
export function legacyDataNotice(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  exists: (path: string) => boolean = existsSync,
): string | null {
  if (env.ATRIUM_DATA !== undefined) return null;
  const legacy = join(home, ".pi", "atrium", "data");
  if (exists(join(home, ".atrium")) || !exists(legacy)) return null;
  return `前一代数据在 ${legacy}，已归档，不再使用；新一代数据放在 ${join(home, ".atrium")}（可用 ATRIUM_DATA 改）`;
}
export function servicePort() {
  const port = Number(process.env.ATRIUM_PORT ?? 4310);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("ATRIUM_PORT 必须为有效端口");
  return port;
}
const recordSchema = z.object({
  instance: z.uuid(),
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  token: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ServiceRecord = z.infer<typeof recordSchema>;
export const serviceUrl = (record: ServiceRecord) =>
  `http://127.0.0.1:${record.port}`;
export function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
function decode(value: unknown): ServiceRecord | null {
  if (!value) return null;
  return recordSchema.parse(JSON.parse((value as { record: string }).record));
}
export function readService(data: string): ServiceRecord | null {
  const path = join(data, "service.sqlite");
  if (!existsSync(path)) return null;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=3000");
    // A concurrent first launch may have created the file but not its table yet.
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='service'").get())
      return null;
    return decode(db.prepare("SELECT record FROM service WHERE id=1").get());
  } finally {
    db.close();
  }
}

/** SQLite serializes claim/reclaim, including concurrent launches after a crash.
 * No heartbeat expiry: an unresponsive but living process retains ownership.
 */
export function claimService(data: string, port: number) {
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const path = join(data, "service.sqlite");
  closeSync(openSync(path, "a", 0o600));
  chmodSync(path, 0o600);
  const db = new DatabaseSync(path);
  const record: ServiceRecord = {
    instance: randomUUID(),
    pid: process.pid,
    port,
    token: randomBytes(32).toString("hex"),
  };
  try {
    db.exec(
      "PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS service (id INTEGER PRIMARY KEY CHECK(id=1), record TEXT NOT NULL); BEGIN IMMEDIATE",
    );
    const previous = decode(
      db.prepare("SELECT record FROM service WHERE id=1").get(),
    );
    if (previous && alive(previous.pid))
      throw new Error(
        `Atrium 已运行或正在启动（PID ${previous.pid}）；不会重复启动。`,
      );
    db.prepare("INSERT OR REPLACE INTO service(id,record) VALUES(1, ?)").run(
      JSON.stringify(record),
    );
    db.exec("COMMIT");
  } catch (error) {
    db.close(); // Rolls back an unfinished claim.
    throw error;
  }
  let released = false;
  return {
    record,
    release() {
      if (released) return;
      released = true;
      try {
        db.prepare("DELETE FROM service WHERE id=1 AND record=?").run(
          JSON.stringify(record),
        );
      } finally {
        db.close();
      }
    },
  };
}
