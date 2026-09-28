import { DatabaseSync } from "node:sqlite";
import {
  ensureWorkerProfiles,
  importWorkerProfiles,
} from "../server/tasks/workers/worker-profiles.ts";

/** 测试用的档案库（#355）：内存库，给了旧式目录就导入一次。 */
export function profileDb(dir?: string, db = new DatabaseSync(":memory:")) {
  ensureWorkerProfiles(db);
  if (dir) importWorkerProfiles(db, dir, () => {});
  return db;
}
