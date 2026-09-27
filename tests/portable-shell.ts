/**
 * 三平台 shell 都能跑的检查命令（Unix `/bin/sh -c`，Windows `cmd.exe /c`，见 server/platform）：
 * 一律写成 `node -e "脚本" "参数"…`。脚本里不用双引号、`$` 与反引号，两种 shell 都原样传给 node。
 */
export const nodeCommand = (script: string, ...args: string[]) =>
  [`node -e "${script}"`, ...args.map((arg) => `"${arg}"`)].join(" ");

/** 成功退出。 */
export const TRUE_COMMAND = nodeCommand("process.exit(0)");

/** 睡若干秒（用来测超时与中断）。 */
export const sleepCommand = (seconds: number) =>
  nodeCommand(`setTimeout(() => {}, ${seconds * 1000})`);
