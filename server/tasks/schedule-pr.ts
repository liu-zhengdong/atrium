import { execFile } from "node:child_process";
import type { Exec } from "./git.ts";

/** PR 查询仅传 gh 查元数据需要的环境；不继承身份、凭据或终端代理变量。 */
export const schedulePrExec: Exec = (command, args, options = {}) =>
  new Promise((resolve) => {
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
    execFile(
      command,
      args,
      {
        env,
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 15_000,
        maxBuffer: 64 * 1024,
      },
      (error, stdout, stderr) =>
        resolve({
          ok: !error,
          stdout: String(stdout),
          stderr: String(stderr || (error ? error.message : "")),
        }),
    );
  });
