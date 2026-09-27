import type { ChildProcess } from "node:child_process";

/**
 * 读子进程 stdout 第一行里的正整数（子进程报的 pid、端口），有上限：
 * 子进程先退出、拉起出错或超时都以带原因的错误结束，不会一直等。
 *
 * 子进程要用 `process.stdout.write` 写纯数字：执行者环境常带 FORCE_COLOR，
 * `console.log(数字)` 会带上颜色码，按数字解析得到 NaN（t141）。
 */
export function readNumberLine(
  child: ChildProcess,
  label: string,
  timeoutMs = 15_000,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    const detail = () =>
      `stdout=${JSON.stringify(out)} stderr=${JSON.stringify(err.slice(-500))}`;
    const onOut = (chunk: Buffer) => {
      out += String(chunk);
      const end = out.indexOf("\n");
      if (end < 0) return;
      const line = out.slice(0, end).trim();
      finish();
      if (/^[1-9][0-9]*$/.test(line)) resolve(Number(line));
      else reject(new Error(`${label}：第一行不是正整数，${detail()}`));
    };
    const onErr = (chunk: Buffer) => (err += String(chunk));
    const onExit = (code: number | null, signal: string | null) => {
      finish();
      reject(
        new Error(
          `${label}：子进程输出前已退出（code=${code} signal=${signal}），${detail()}`,
        ),
      );
    };
    const onError = (error: Error) => {
      finish();
      reject(new Error(`${label}：子进程拉起失败：${error.message}`));
    };
    const timer = setTimeout(() => {
      finish();
      reject(new Error(`${label}：${timeoutMs} 毫秒内没有输出，${detail()}`));
    }, timeoutMs);
    function finish() {
      clearTimeout(timer);
      child.stdout?.off("data", onOut);
      child.stderr?.off("data", onErr);
      child.off("exit", onExit);
      child.off("error", onError);
    }
    child.stdout?.on("data", onOut);
    child.stderr?.on("data", onErr);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

/** 等子进程退出，有上限；已经退出的立即返回。超时报 `message`。 */
export function waitExit(
  child: ChildProcess,
  message: string,
  timeoutMs = 10_000,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error(`${message}（等了 ${timeoutMs} 毫秒）`));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", onExit);
  });
}
