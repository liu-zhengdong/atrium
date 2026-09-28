import { connect } from "node:net";
import { endpointGone } from "./plan.ts";

/**
 * Claude Code 会话收件地址的 IO（t243）：Unix socket 与 Windows 命名管道都走 `net.connect(path)`。
 * 判定（地址认不认、哪些错误算会话没了）在 `plan.ts`；这里单独成文件，只有 `secretary bridge` 按需加载，
 * 不进命令行的启动路径。
 */

export type EndpointResult =
  { ok: true } | { ok: false; gone: boolean; message: string };

const failure = (error: unknown): EndpointResult => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return {
    ok: false,
    gone: endpointGone(process.platform, code),
    message: error instanceof Error ? error.message : String(error),
  };
};

/**
 * 连上地址、写完各行（每行以换行结尾）后关闭写端，等对端关闭或 timeoutMs 到点。
 * Claude Code 不回执：写完、没出错就算送到。
 */
export function postLines(
  path: string,
  lines: readonly string[],
  timeoutMs = 5000,
): Promise<EndpointResult> {
  return new Promise((resolve) => {
    let settled = false;
    let written = false;
    const socket = connect(path);
    const finish = (result: EndpointResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(
      () =>
        finish(
          written
            ? { ok: true }
            : { ok: false, gone: false, message: "连会话收件地址超时" },
        ),
      timeoutMs,
    );
    socket.once("error", (error) =>
      finish(written ? { ok: true } : failure(error)),
    );
    socket.once("close", () =>
      finish(
        written
          ? { ok: true }
          : { ok: false, gone: false, message: "会话收件地址提前断开" },
      ),
    );
    socket.once("connect", () => {
      socket.end(lines.map((line) => `${line}\n`).join(""), () => {
        written = true;
      });
    });
    // 对端不读也不关时，写完即可结束。
    socket.once("finish", () => {
      written = true;
      setTimeout(() => finish({ ok: true }), 200).unref();
    });
  });
}

/** 会话还在不在：连一下就断，不发任何内容（Claude Code 对没发完整一行的连接直接关掉）。 */
export function probeEndpoint(
  path: string,
  timeoutMs = 3000,
): Promise<EndpointResult> {
  return new Promise((resolve) => {
    const socket = connect(path);
    const finish = (result: EndpointResult) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, gone: false, message: "探测超时" }),
      timeoutMs,
    );
    socket.once("connect", () => finish({ ok: true }));
    socket.once("error", (error) => finish(failure(error)));
  });
}
