// server/service-state.ts
import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
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
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
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

export {
  packageRoot,
  currentVersion,
  dataDirectory,
  isDefaultData,
  legacyDataNotice,
  servicePort,
  serviceUrl,
  alive,
  readService
};
