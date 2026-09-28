import {
  processAlive,
  restrictToOwner
} from "./chunk-HEN5YN5G.js";

// server/service-state.ts
import { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
var packageRoot = fileURLToPath(new URL("../", import.meta.url));
var bootVersion = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8")
    );
    return pkg.version ?? "0.1.0";
  } catch {
    return "0.1.0";
  }
})();
function currentVersion() {
  return bootVersion;
}
function dataDirectory(env = process.env, home = homedir()) {
  const path = resolve(env.ATRIUM_DATA ?? join(home, ".atrium"));
  return existsSync(path) ? realpathSync(path) : path;
}
function isDefaultData(data = dataDirectory(), home = homedir()) {
  const path = existsSync(data) ? realpathSync(data) : resolve(data);
  return path === dataDirectory({}, home);
}
function legacyDataNotice(env = process.env, home = homedir(), exists = existsSync) {
  if (env.ATRIUM_DATA !== void 0) return null;
  const legacy = join(home, ".pi", "atrium", "data");
  if (exists(join(home, ".atrium")) || !exists(legacy)) return null;
  return `\u524D\u4E00\u4EE3\u6570\u636E\u5728 ${legacy}\uFF0C\u5DF2\u5F52\u6863\uFF0C\u4E0D\u518D\u4F7F\u7528\uFF1B\u65B0\u4E00\u4EE3\u6570\u636E\u653E\u5728 ${join(home, ".atrium")}\uFF08\u53EF\u7528 ATRIUM_DATA \u6539\uFF09`;
}
function servicePort() {
  const port = Number(process.env.ATRIUM_PORT ?? 4310);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("ATRIUM_PORT \u5FC5\u987B\u4E3A\u6709\u6548\u7AEF\u53E3");
  return port;
}
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var isInt = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
function parseServiceRecord(value) {
  const record = value ?? {};
  if (typeof value !== "object" || value === null || typeof record.instance !== "string" || !UUID.test(record.instance) || !isInt(record.pid, 1, Number.MAX_SAFE_INTEGER) || !isInt(record.port, 1, 65535) || typeof record.token !== "string" || !/^[a-f0-9]{64}$/.test(record.token))
    throw new Error("\u670D\u52A1\u767B\u8BB0\u8BB0\u5F55\u683C\u5F0F\u4E0D\u5BF9");
  const { instance, pid, port, token } = record;
  return { instance, pid, port, token };
}
var serviceUrl = (record) => `http://127.0.0.1:${record.port}`;
var alive = processAlive;
function decode(value) {
  if (!value) return null;
  return parseServiceRecord(JSON.parse(value.record));
}
function readService(data) {
  const path = join(data, "service.sqlite");
  if (!existsSync(path)) return null;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=3000");
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='service'").get())
      return null;
    return decode(db.prepare("SELECT record FROM service WHERE id=1").get());
  } finally {
    db.close();
  }
}
function claimService(data, port) {
  mkdirSync(data, { recursive: true, mode: 448 });
  const path = join(data, "service.sqlite");
  closeSync(openSync(path, "a", 384));
  restrictToOwner(path);
  const db = new DatabaseSync(path);
  const record = {
    instance: randomUUID(),
    pid: process.pid,
    port,
    token: randomBytes(32).toString("hex")
  };
  try {
    db.exec(
      "PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS service (id INTEGER PRIMARY KEY CHECK(id=1), record TEXT NOT NULL); BEGIN IMMEDIATE"
    );
    const previous = decode(
      db.prepare("SELECT record FROM service WHERE id=1").get()
    );
    if (previous && alive(previous.pid))
      throw new Error(
        `Atrium \u5DF2\u8FD0\u884C\u6216\u6B63\u5728\u542F\u52A8\uFF08PID ${previous.pid}\uFF09\uFF1B\u4E0D\u4F1A\u91CD\u590D\u542F\u52A8\u3002`
      );
    db.prepare("INSERT OR REPLACE INTO service(id,record) VALUES(1, ?)").run(
      JSON.stringify(record)
    );
    db.exec("COMMIT");
  } catch (error) {
    db.close();
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
          JSON.stringify(record)
        );
      } finally {
        db.close();
      }
    }
  };
}

export {
  packageRoot,
  currentVersion,
  dataDirectory,
  isDefaultData,
  legacyDataNotice,
  servicePort,
  parseServiceRecord,
  serviceUrl,
  alive,
  readService,
  claimService
};
