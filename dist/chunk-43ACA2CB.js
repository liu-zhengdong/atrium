import {
  restrictToOwner
} from "./chunk-HEN5YN5G.js";

// server/agent/state.ts
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
function agentDataDir(env = process.env) {
  const configured = env.ATRIUM_AGENT_DATA?.trim();
  return resolve(configured || join(env.HOME || homedir(), ".atrium-agent"));
}
function renameRetrying(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = error.code;
      if (attempt >= 10 || code !== "EPERM" && code !== "EBUSY") throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}
function writeSecretFile(path, text) {
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, text, { mode: 384 });
  try {
    renameRetrying(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
  restrictToOwner(path);
}
var AgentState = class {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(join(dir, "runs"), { recursive: true, mode: 448 });
  }
  dir;
  get configFile() {
    return join(this.dir, "agent.json");
  }
  /** 接入过的服务与令牌；没有或写坏了为 null（坏文件挪开留档）。 */
  config() {
    if (!existsSync(this.configFile)) return null;
    try {
      const value = JSON.parse(
        readFileSync(this.configFile, "utf8")
      );
      if (typeof value.server === "string" && typeof value.host === "string" && typeof value.token === "string")
        return value;
    } catch {
    }
    renameSync(this.configFile, `${this.configFile}.invalid-${Date.now()}`);
    return null;
  }
  saveConfig(config) {
    writeSecretFile(this.configFile, `${JSON.stringify(config)}
`);
  }
  runFile(task) {
    return join(this.dir, "runs", `${task}.json`);
  }
  saveRun(run) {
    writeSecretFile(this.runFile(run.task), JSON.stringify(run));
  }
  removeRun(task) {
    rmSync(this.runFile(task), { force: true, maxRetries: 10, retryDelay: 50 });
  }
  /** 读全部运行记录；单条写坏的挪开并记下，其余照常。 */
  runs(onBad) {
    const found = [];
    for (const name of readdirSync(join(this.dir, "runs"))) {
      if (!/^[0-9]+\.json$/.test(name)) continue;
      const file = join(this.dir, "runs", name);
      try {
        const run = JSON.parse(readFileSync(file, "utf8"));
        if (Number.isSafeInteger(run.task) && Number.isSafeInteger(run.run)) {
          found.push(run);
          continue;
        }
      } catch {
      }
      renameSync(file, `${file}.invalid-${Date.now()}`);
      onBad?.(file);
    }
    return found.sort((a, b) => a.task - b.task);
  }
};

export {
  agentDataDir,
  AgentState
};
