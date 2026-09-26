import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Problem } from "./problem.ts";

const MAX_FILE_BYTES = 1024 * 1024;
const unsafe = () =>
  new Problem(409, "容器身份文件不安全或超出大小限制", "container_file_unsafe");

/** Only call while the container is stopped/fenced: path checks cannot beat a concurrent rename. */
function checkedPath(root: string, file: string) {
  const original = lstatSync(root);
  if (!original.isDirectory() || original.isSymbolicLink()) throw unsafe();
  const base = realpathSync(root);
  const target = resolve(base, file);
  const suffix = relative(base, target);
  if (
    !suffix ||
    suffix === ".." ||
    suffix.startsWith(`..${sep}`) ||
    isAbsolute(suffix)
  )
    throw unsafe();
  let parent = dirname(target);
  while (parent !== base) {
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unsafe();
    parent = dirname(parent);
    if (parent === dirname(parent)) throw unsafe();
  }
  return target;
}

/** A FIFO, socket, device or oversized file must never block or exhaust the Web process. */
export function readContainerFile(
  root: string,
  file: string,
  maxBytes = MAX_FILE_BYTES,
) {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_FILE_BYTES
  )
    throw unsafe();
  let fd: number | undefined;
  try {
    const path = checkedPath(root, file);
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw unsafe();
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let size = 0;
    while (size <= maxBytes) {
      const count = readSync(fd, buffer, size, maxBytes + 1 - size, null);
      if (!count) return buffer.subarray(0, size);
      size += count;
    }
    throw unsafe();
  } catch (error) {
    if (error instanceof Problem) throw error;
    throw unsafe();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Replace only a regular leaf under a stopped container's authorized tree. */
export function writeContainerFile(
  root: string,
  file: string,
  content: Buffer | string,
) {
  const payload = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (payload.length > MAX_FILE_BYTES) throw unsafe();
  let temporary: string | undefined;
  try {
    const target = checkedPath(root, file);
    try {
      const existing = lstatSync(target);
      if (!existing.isFile() || existing.isSymbolicLink()) throw unsafe();
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
    temporary = join(
      dirname(target),
      `.atrium-${randomBytes(16).toString("hex")}.tmp`,
    );
    const fd = openSync(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      let offset = 0;
      while (offset < payload.length)
        offset += writeSync(fd, payload, offset, payload.length - offset);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, target);
  } catch (error) {
    if (error instanceof Problem) throw error;
    throw unsafe();
  } finally {
    if (temporary) rmSync(temporary, { force: true });
  }
}
