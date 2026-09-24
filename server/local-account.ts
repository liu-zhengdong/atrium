import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./store.ts";
import { defaultTemplate } from "./profile.ts";

/** Local login is an explicit delegation to a CLI; no auth material enters Atrium. */
export const LOCAL_PROVIDERS = {
  "claude-bridge": {
    name: "Claude Code（本机登录）",
    cli: "claude",
    config: "claude-bridge.json",
  },
} as const;
export type LocalProvider = keyof typeof LOCAL_PROVIDERS;
export const LOCAL_PROVIDER: LocalProvider = "claude-bridge";
export const LOCAL_NAME = LOCAL_PROVIDERS[LOCAL_PROVIDER].name;
export const LOCAL_COMMAND = "claude --version";

function executable(store: Store, agentId?: string): string {
  const directory = agentId
    ? store.agent(agentId).agent_directory
    : defaultTemplate();
  if (!directory) return LOCAL_PROVIDERS[LOCAL_PROVIDER].cli;
  const configPath = join(directory, LOCAL_PROVIDERS[LOCAL_PROVIDER].config);
  if (!existsSync(configPath)) return LOCAL_PROVIDERS[LOCAL_PROVIDER].cli;
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      provider?: { pathToClaudeCodeExecutable?: unknown };
    };
    const path = config.provider?.pathToClaudeCodeExecutable;
    return typeof path === "string" && path.trim()
      ? path
      : LOCAL_PROVIDERS[LOCAL_PROVIDER].cli;
  } catch {
    return "";
  }
}

export function checkLocalLogin(store: Store, agentId?: string): string | null {
  const cli = executable(store, agentId);
  if (!cli)
    return `Claude CLI 配置无法读取；请检查 ${LOCAL_PROVIDERS[LOCAL_PROVIDER].config}`;
  const result = spawnSync(cli, ["--version"], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 1024,
  });
  // Version only: never inspect or modify ~/.claude, and never issue a billed request.
  if (result.error || result.status !== 0)
    return `Claude CLI 不可用；请安装 Claude Code 或修正模板 ${LOCAL_PROVIDERS[LOCAL_PROVIDER].config} 中的可执行路径，再运行 ${LOCAL_COMMAND}`;
  return null;
}
