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
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

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
  roots?: { from: string; to: string },
) {
  if (lstatExists(to)) {
    cpSync(
      from,
      to,
      options.dereference ? options : { ...options, verbatimSymlinks: true },
    );
    if (roots) relocateLinks(to, { ...roots, itemFrom: from, itemTo: to });
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
    normalizeTree(to, roots && { ...roots, itemFrom: from, itemTo: to });
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
    cpSync(
      from,
      to,
      options.dereference ? options : { ...options, verbatimSymlinks: true },
    );
    if (roots) relocateLinks(to, { ...roots, itemFrom: from, itemTo: to });
  }
}

// Node cpSync creates directories using umask, while system cp preserves their modes.
// Relative links remain relative; only absolute links into the source root move.
type Roots = { from: string; to: string; itemFrom: string; itemTo: string };
function normalizeTree(to: string, roots?: Roots) {
  const stat = lstatSync(to);
  if (stat.isSymbolicLink()) {
    if (roots) relocateLink(to, roots);
    return;
  }
  if (!stat.isDirectory()) return;
  chmodSync(to, 0o777 & ~process.umask());
  for (const entry of readdirSync(to, { withFileTypes: true }))
    if (entry.isSymbolicLink() || entry.isDirectory())
      normalizeTree(join(to, entry.name), roots);
}
function relocateLinks(to: string, roots: Roots) {
  if (lstatSync(to).isSymbolicLink()) return relocateLink(to, roots);
  if (!lstatSync(to).isDirectory()) return;
  for (const entry of readdirSync(to, { withFileTypes: true }))
    if (entry.isSymbolicLink() || entry.isDirectory())
      relocateLinks(join(to, entry.name), roots);
}
function relocateLink(to: string, roots: Roots) {
  const link = readlinkSync(to);
  const original = isAbsolute(link)
    ? link
    : resolve(dirname(join(roots.itemFrom, relative(roots.itemTo, to))), link);
  const source = join(canonicalPath(dirname(original)), basename(original));
  if (!isAbsolute(link)) {
    const withinItem = relative(canonicalPath(roots.itemFrom), source);
    if (
      withinItem !== ".." &&
      !withinItem.startsWith(`..${sep}`) &&
      !isAbsolute(withinItem)
    )
      return;
  }
  for (const [from, destination] of [
    [roots.itemFrom, roots.itemTo],
    [roots.from, roots.to],
  ]) {
    const within = relative(canonicalPath(from), source);
    if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within))
      continue;
    rmSync(to);
    symlinkSync(relative(dirname(to), join(destination, within)) || ".", to);
    return;
  }
  if (!isAbsolute(link)) {
    rmSync(to);
    symlinkSync(relative(dirname(to), source), to);
  }
}

export function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) return path;
    return join(canonicalPath(parent), basename(path));
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
