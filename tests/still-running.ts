import { STILL_RUNNING } from "../server/tasks/check-quiet.ts";

/**
 * 测试运行器的「仍在跑」心跳（t260）：纯函数，穷举测试；接 node --test 事件的 reporter 在 still-running-reporter.ts。
 * 某个测试文件 quietMs 没有用例结束，就打印「仍在跑：tests/a.test.ts（已 N 秒）」，之后每 quietMs 再打一次，
 * 方便从检查日志里定位挂住的文件。检查的「没输出」检测不把这行算输出（server/tasks/check-quiet.ts）。
 */

/** 一个文件多久没有用例结束就打印。 */
export const STILL_RUNNING_MS = 60_000;

export type FileRun = {
  /** 文件开始跑的时刻。 */
  startedAt: number;
  /** 最近一个用例结束的时刻（还没有就是开始时刻）。 */
  lastDoneAt: number;
  /** 上次打印心跳的时刻；没打印过为 null。 */
  printedAt: number | null;
};

/** 从 node --test 事件里取出的一步：文件开始、文件结束、某个用例结束。 */
export type RunStep =
  | { kind: "file_start"; file: string }
  | { kind: "file_end"; file: string }
  | { kind: "test_done"; file: string };

/**
 * node --test 事件 → 一步；不关心的为 null。文件级事件的 name 就是文件路径（nesting 0）；
 * 文件里的用例带 file、name 是用例名。
 */
export function runStep(event: {
  type: string;
  data?: { file?: unknown; name?: unknown; nesting?: unknown } | null;
}): RunStep | null {
  const file = event.data?.file;
  if (typeof file !== "string" || !file) return null;
  const whole = event.data?.nesting === 0 && event.data?.name === file;
  if (event.type === "test:dequeue" && whole)
    return { kind: "file_start", file };
  if (event.type === "test:complete")
    return whole ? { kind: "file_end", file } : { kind: "test_done", file };
  return null;
}

/** 按一步更新在跑的文件（原地改）。 */
export function applyStep(
  files: Map<string, FileRun>,
  step: RunStep,
  now: number,
) {
  if (step.kind === "file_start")
    files.set(step.file, { startedAt: now, lastDoneAt: now, printedAt: null });
  else if (step.kind === "file_end") files.delete(step.file);
  else {
    const run = files.get(step.file);
    if (run) run.lastDoneAt = now;
  }
}

/** 这一刻该为哪些文件打印心跳：quietMs 没有用例结束，且距上次打印（或最近一个用例结束）也满 quietMs；跑得久的在前。 */
export function dueFiles(
  files: ReadonlyMap<string, FileRun>,
  now: number,
  quietMs = STILL_RUNNING_MS,
): { file: string; seconds: number }[] {
  const due: { file: string; seconds: number }[] = [];
  for (const [file, run] of files) {
    const since = Math.max(run.lastDoneAt, run.printedAt ?? 0);
    if (now - since < quietMs) continue;
    due.push({ file, seconds: Math.floor((now - run.startedAt) / 1000) });
  }
  return due.sort(
    (a, b) => b.seconds - a.seconds || (a.file < b.file ? -1 : 1),
  );
}

/** 心跳一行。 */
export function stillRunningLine(file: string, seconds: number) {
  return `${STILL_RUNNING}${file}（已 ${seconds} 秒）`;
}
