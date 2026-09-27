import { homedir } from "node:os";
import { join } from "node:path";
import { dataDirectory, isDefaultData } from "../service-state.ts";

/**
 * 旧的 `~/Atrium` 目录：ATRIUM_LEGACY_DIR 可改。只有默认数据目录的服务才缺省读主目录；
 * 另给 ATRIUM_DATA 的隔离服务与 node:test 派生的服务没显式给就不导入（t128）。
 */
export function legacyDir(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
) {
  if (env.ATRIUM_LEGACY_DIR) return env.ATRIUM_LEGACY_DIR;
  if (env.NODE_TEST_CONTEXT) return undefined;
  if (!isDefaultData(dataDirectory(env, home), home)) return undefined;
  return join(home, "Atrium");
}

/**
 * 旧版执行者档案目录（首次启动导入一次）：ATRIUM_WORKERS_DIR 可改，缺省是旧目录下的 workers；
 * 与 legacyDir 同一条规矩，隔离服务不读主目录。
 */
export function legacyWorkersDir(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
) {
  if (env.ATRIUM_WORKERS_DIR) return env.ATRIUM_WORKERS_DIR;
  const legacy = legacyDir(env, home);
  return legacy ? join(legacy, "workers") : undefined;
}
