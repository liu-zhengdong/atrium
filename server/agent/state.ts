import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { restrictToOwner } from "../platform/index.ts";

/**
 * 代理自己的数据（#358 第 1 步）：接入后的主机令牌（只存在这台机器上，0600）、
 * 每个在跑任务的一份运行记录（代理重启后据此接着看进程、补传日志与退出）。
 * 仓库、工作树、任务日志也放在这个目录下（server/hosts/state.ts remoteLayout）。
 */

export function agentDataDir(env: NodeJS.ProcessEnv = process.env) {
  const configured = env.ATRIUM_AGENT_DATA?.trim();
  return resolve(configured || join(env.HOME || homedir(), ".atrium-agent"));
}

export type AgentConfig = { server: string; host: string; token: string };

/** 一次远程运行在代理这边的记录。 */
export type RunRecord = {
  task: number;
  run: number;
  ref: string;
  tool: string;
  /** 可执行文件名：重启后按命令行核对 pid 还是不是它。 */
  executable: string;
  pid: number;
  logFile: string;
  resultFile: string;
  startedAt: number;
  /** 已经传到服务的远程日志字节数。 */
  uploaded: number;
  /** 退出情况；null 表示退出码不可得（代理重启时进程已不在）；没退出时不给。 */
  exit?: { code: number | null; signal: string | null } | null;
};

/** Windows 上刚写过的文件可能被杀毒短暂锁住：改名遇到 EPERM / EBUSY 稍等重试几次。 */
function renameRetrying(from: string, to: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 10 || (code !== "EPERM" && code !== "EBUSY")) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

function writeSecretFile(path: string, text: string) {
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  try {
    renameRetrying(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
  restrictToOwner(path);
}

export class AgentState {
  constructor(readonly dir: string) {
    mkdirSync(join(dir, "runs"), { recursive: true, mode: 0o700 });
  }

  private get configFile() {
    return join(this.dir, "agent.json");
  }

  /** 接入过的服务与令牌；没有或写坏了为 null（坏文件挪开留档）。 */
  config(): AgentConfig | null {
    if (!existsSync(this.configFile)) return null;
    try {
      const value = JSON.parse(
        readFileSync(this.configFile, "utf8"),
      ) as AgentConfig;
      if (
        typeof value.server === "string" &&
        typeof value.host === "string" &&
        typeof value.token === "string"
      )
        return value;
    } catch {
      // 落到下面挪开。
    }
    renameSync(this.configFile, `${this.configFile}.invalid-${Date.now()}`);
    return null;
  }

  saveConfig(config: AgentConfig) {
    writeSecretFile(this.configFile, `${JSON.stringify(config)}\n`);
  }

  private runFile(task: number) {
    return join(this.dir, "runs", `${task}.json`);
  }

  saveRun(run: RunRecord) {
    writeSecretFile(this.runFile(run.task), JSON.stringify(run));
  }

  removeRun(task: number) {
    rmSync(this.runFile(task), { force: true, maxRetries: 10, retryDelay: 50 });
  }

  /** 读全部运行记录；单条写坏的挪开并记下，其余照常。 */
  runs(onBad?: (file: string) => void): RunRecord[] {
    const found: RunRecord[] = [];
    for (const name of readdirSync(join(this.dir, "runs"))) {
      if (!/^[0-9]+\.json$/.test(name)) continue;
      const file = join(this.dir, "runs", name);
      try {
        const run = JSON.parse(readFileSync(file, "utf8")) as RunRecord;
        if (Number.isSafeInteger(run.task) && Number.isSafeInteger(run.run)) {
          found.push(run);
          continue;
        }
      } catch {
        // 落到下面挪开。
      }
      renameSync(file, `${file}.invalid-${Date.now()}`);
      onBad?.(file);
    }
    return found.sort((a, b) => a.task - b.task);
  }
}
