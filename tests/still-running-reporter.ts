import { realpathSync } from "node:fs";
import { relative, sep } from "node:path";
import {
  applyStep,
  dueFiles,
  runStep,
  stillRunningLine,
  STILL_RUNNING_MS,
  type FileRun,
} from "./still-running.ts";

/**
 * node --test 的附加 reporter（tests/run-tests.ts 挂上）：某个测试文件长时间没有用例结束时往标准错误打印
 * 「仍在跑：tests/a.test.ts（已 N 秒）」（判定在 still-running.ts）。自己不产出报告内容，原来的 spec 输出不变。
 * 文件级事件的路径是命令行给的写法，用例事件是真实路径（macOS 的 /var 与 /private/var），统一取真实路径再对。
 */

const quietMs = (() => {
  const raw = Number(process.env.ATRIUM_TEST_STILL_RUNNING_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : STILL_RUNNING_MS;
})();

const real = new Map<string, string>();
function canonical(file: string) {
  let found = real.get(file);
  if (found === undefined) {
    try {
      found = realpathSync.native(file);
    } catch {
      found = file;
    }
    real.set(file, found);
  }
  return found;
}

const root = (() => {
  try {
    return realpathSync.native(process.cwd());
  } catch {
    return process.cwd();
  }
})();

const shown = (file: string) => {
  const rel = relative(root, file);
  return (rel.startsWith("..") ? file : rel).split(sep).join("/");
};

export default async function* stillRunningReporter(
  source: AsyncIterable<{ type: string; data?: Record<string, unknown> }>,
): AsyncGenerator<string> {
  const files = new Map<string, FileRun>();
  const timer = setInterval(
    () => {
      const now = Date.now();
      for (const { file, seconds } of dueFiles(files, now, quietMs)) {
        process.stderr.write(`${stillRunningLine(shown(file), seconds)}\n`);
        files.get(file)!.printedAt = now;
      }
    },
    Math.min(5_000, quietMs),
  );
  timer.unref();
  try {
    for await (const event of source) {
      const step = runStep(event as Parameters<typeof runStep>[0]);
      if (step)
        applyStep(files, { ...step, file: canonical(step.file) }, Date.now());
    }
  } finally {
    clearInterval(timer);
  }
  yield* [];
}
