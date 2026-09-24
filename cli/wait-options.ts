export function sequence(
  value: string | undefined,
  flag: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error(`${flag} 必须是非负整数序号`);
  return Number(value);
}

export function readBounds(after?: string, before?: string) {
  if (after !== undefined && before !== undefined)
    throw new Error("--after 和 --before 不能同时使用");
  const a = sequence(after, "--after");
  const b = sequence(before, "--before");
  if (b === 0) throw new Error("--before 必须大于 0");
  return a !== undefined
    ? `?after=${a}`
    : b !== undefined
      ? `?before=${b}`
      : "";
}

export function waitOptions(after?: string, timeout?: string, idle = false) {
  if (idle && after !== undefined)
    throw new Error("--idle 不能与 --after 同时使用");
  const cursor = sequence(after, "--after");
  const seconds = timeout === undefined ? 300 : sequence(timeout, "--timeout");
  if (!seconds || seconds > 3600)
    throw new Error("--timeout 必须在 1 到 3600 秒之间");
  return { cursor, seconds };
}

export const nextMessage = (
  verb: "等新消息" | "继续等",
  ref: string,
  id: number,
) => `${verb}：atrium wait ${ref} --after ${id}`;
export const nextTrace = (ref: string) => `查看轨迹：atrium trace ${ref}`;
