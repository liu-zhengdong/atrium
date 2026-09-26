import { open, stat } from "node:fs/promises";

/** 增量读执行者日志（#262）：按字节偏移，每次最多 64 KiB，不切断 UTF-8 字符。 */

export const LOG_CHUNK = 64 * 1024;

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
