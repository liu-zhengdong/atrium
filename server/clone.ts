import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  type CopySyncOptions,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

let reportedFallback = false;
type CopyCommand = (command: string, args: string[]) => void;
const systemCopy: CopyCommand = (command, args) => {
  execFileSync(command, args, { stdio: "pipe" });
};

/** Copy-on-write for fresh destinations; Node handles merges so cpSync's overwrite policy stays intact. */
export function clone(
  from: string,
  to: string,
  options: CopySyncOptions = { recursive: true },
  copy: CopyCommand = systemCopy,
) {
  if (lstatExists(to)) {
    cpSync(from, to, options);
    return;
  }
  const directory = lstatSync(from).isDirectory();
  const args =
    process.platform === "darwin"
      ? ["-c", "-R", options.dereference ? "-L" : "-P"]
      : ["--reflink=auto", "-R", options.dereference ? "-L" : "-P"];
  try {
    copy("cp", [
      ...(directory ? args : args.filter((flag) => flag !== "-R")),
      "--",
      from,
      to,
    ]);
    normalizeTree(from, to, options.dereference === true);
  } catch (error) {
    // cp may have left a partial tree. Never overlay it with the fallback.
    rmSync(to, { recursive: true, force: true });
    if (!reportedFallback) {
      reportedFallback = true;
      const stderr = (error as { stderr?: Buffer })?.stderr?.toString().trim();
      const reason =
        stderr || (error instanceof Error ? error.message : String(error));
      console.warn(`克隆不可用，已退回普通复制（${reason.split("\n")[0]}）`);
    }
    cpSync(from, to, options);
  }
}

// Node cpSync creates directories using umask, while system cp preserves their modes;
// Node also resolves relative links against their original directory by default.
function normalizeTree(from: string, to: string, dereference: boolean) {
  const stat = lstatSync(to);
  if (stat.isSymbolicLink()) {
    if (!dereference) normalizeLink(from, to);
    return;
  }
  if (!stat.isDirectory()) return;
  chmodSync(to, 0o777 & ~process.umask());
  const sourceDir = realpathSync(from);
  for (const entry of readdirSync(to, { withFileTypes: true }))
    if (entry.isSymbolicLink() || entry.isDirectory())
      normalizeTree(
        join(sourceDir, entry.name),
        join(to, entry.name),
        dereference,
      );
}
function normalizeLink(from: string, to: string) {
  const link = readlinkSync(from);
  if (!link.startsWith("/")) {
    rmSync(to);
    symlinkSync(resolve(dirname(from), link), to);
  }
}

function lstatExists(path: string) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
