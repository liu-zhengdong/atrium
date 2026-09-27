import { open, stat } from "node:fs/promises";

/** 增量读执行者日志（#262）：按字节偏移，每次最多 64 KiB，不切断 UTF-8 字符。 */

export const LOG_CHUNK = 64 * 1024;
/** 看板取「最近一个动作」时读日志尾部的字节数：固定有界，不整份读。 */
export const LOG_TAIL = 64 * 1024;

export async function readLogChunk(file: string, offset: number) {
  let size = 0;
  try {
    size = (await stat(file)).size;
  } catch {
    return { text: "", next: 0, size: 0 };
  }
  const start = Math.min(offset, size);
  const length = Math.min(size - start, LOG_CHUNK);
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    // 末尾是半个字符就留到下一次。
    let end = length;
    if (start + length < size) {
      while (end > 0 && (buffer[end - 1]! & 0xc0) === 0x80) end--;
      if (end > 0 && buffer[end - 1]! >= 0xc0) end--;
    }
    return {
      text: buffer.subarray(0, end).toString("utf8"),
      next: start + end,
      size,
    };
  } finally {
    await handle.close();
  }
}

/**
 * 读日志尾部固定字节数（#262 `atrium top`）：只看最后 max 字节，不读整份。
 * 开头切在半个字符上时丢掉那几个续字节；文件不存在按空日志处理。
 */
export async function readLogTail(file: string, max = LOG_TAIL) {
  let size = 0;
  let at = 0;
  try {
    const info = await stat(file);
    size = info.size;
    at = info.mtimeMs;
  } catch {
    return { text: "", size: 0, at: 0 };
  }
  const start = Math.max(0, size - max);
  const length = size - start;
  if (!length) return { text: "", size, at };
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    let from = 0;
    // 开头可能是某个 UTF-8 字符的后半截：连续的续字节都丢掉。
    if (start > 0)
      while (from < length && (buffer[from]! & 0xc0) === 0x80) from++;
    return { text: buffer.subarray(from).toString("utf8"), size, at };
  } finally {
    await handle.close();
  }
}
