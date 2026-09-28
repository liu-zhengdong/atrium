import { homedir } from "node:os";
import { runFile } from "../platform/index.ts";
import type { Exec } from "./git.ts";

/** PR 查询仅传 gh 查元数据需要的环境；不继承身份、凭据或终端代理变量。 */
export const schedulePrExec: Exec = async (command, args, options = {}) => {
  const env: NodeJS.ProcessEnv = {
    GH_PROMPT_DISABLED: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LANG",
    "GH_CONFIG_DIR",
    "XDG_CONFIG_HOME",
    "GH_HOST",
  ])
    if (process.env[key]) env[key] = process.env[key];
  const { error, stdout, stderr } = await runFile(command, args, {
    env,
    cwd: options.cwd ?? homedir(),
    timeout: options.timeoutMs ?? 15_000,
    maxBuffer: 64 * 1024,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return {
    ok: !error,
    stdout,
    stderr: stderr || (error ? error.message : ""),
  };
};
