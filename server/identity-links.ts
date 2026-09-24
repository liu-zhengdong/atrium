import {
  existsSync,
  readdirSync,
  statSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { canonicalPath } from "./clone.ts";
import { defaultTemplate } from "./profile.ts";

type Link = { path: string; target: string };
export type LinkPlan = {
  rewrites: Link[];
  missing: Link[];
  errors: { path: string; reason: string }[];
};

function inside(root: string, path: string): string | null {
  const part = relative(root, path);
  return part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part)
    ? null
    : part;
}

/** Inspect symlinks only; directory links are never followed. Safe to use for a read-only audit. */
export function inspectTemplateLinks(
  identity: string,
  template = defaultTemplate(),
): LinkPlan {
  const rewrites: Link[] = [],
    missing: Link[] = [],
    errors: LinkPlan["errors"] = [];
  const source = canonicalPath(template);
  const destination = canonicalPath(identity);
  function visit(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      try {
        if (entry.isDirectory()) {
          visit(path);
          continue;
        }
        if (!entry.isSymbolicLink()) continue;
        const link = readlinkSync(path);
        if (!isAbsolute(link)) continue;
        const within = inside(source, canonicalPath(link));
        if (within === null) continue;
        const target = join(identity, within);
        // Do not replace a working link with a missing target or another route to the template.
        const item = { path, target };
        if (
          !existsSync(target) ||
          inside(destination, canonicalPath(target)) === null
        )
          missing.push(item);
        else rewrites.push(item);
      } catch (error) {
        errors.push({ path, reason: String(error) });
      }
    }
  }
  if (statSync(identity).isDirectory()) visit(identity);
  return { rewrites, missing, errors };
}

/** Replace only links, atomically: a failed rename leaves the original link intact. */
export function repairTemplateLinks(
  identity: string,
  template = defaultTemplate(),
  warn: (message: string) => void = console.warn,
) {
  const started = performance.now();
  const { rewrites, missing, errors } = inspectTemplateLinks(
    identity,
    template,
  );
  for (const { path, reason } of errors)
    warn(`跳过无法扫描的链接或目录 ${path}：${reason}`);
  for (const { path, target } of missing)
    warn(
      `保留指向模板的链接 ${path}：身份内对应目标不存在或不在身份内（${target}）`,
    );
  let repaired = 0;
  for (const { path, target } of rewrites) {
    const temp = `${path}.atrium-${randomUUID()}.tmp`;
    try {
      symlinkSync(relative(dirname(path), target) || ".", temp);
      renameSync(temp, path);
      repaired++;
    } catch (error) {
      warn(`修复链接失败 ${path}：${error}`);
    } finally {
      rmSync(temp, { force: true });
    }
  }
  return {
    repaired,
    missing: missing.length,
    failed: errors.length,
    elapsedMs: performance.now() - started,
  };
}
