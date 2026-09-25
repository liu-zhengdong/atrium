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
import type { Store } from "./store.ts";

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
  let failed = errors.length;
  for (const { path, target } of rewrites) {
    const temp = `${path}.atrium-${randomUUID()}.tmp`;
    try {
      symlinkSync(relative(dirname(path), target) || ".", temp);
      renameSync(temp, path);
      repaired++;
    } catch (error) {
      failed++;
      warn(`修复链接失败 ${path}：${error}`);
    } finally {
      rmSync(temp, { force: true });
    }
  }
  return {
    repaired,
    missing: missing.length,
    failed,
    elapsedMs: performance.now() - started,
  };
}

/** One-time migration per identity, directory and template. Failed scans retry on the next start. */
export function migrateTemplateLinks(
  store: Store,
  agentId: string,
  identity: string,
  template = defaultTemplate(),
  warn: (message: string) => void = console.warn,
) {
  const started = performance.now();
  const mark = store.one<{ directory: string; template: string }>(
    "SELECT directory,template FROM identity_link_migrations WHERE agent_id=?",
    agentId,
  );
  if (mark?.directory === identity && mark.template === template)
    return {
      repaired: 0,
      missing: 0,
      failed: 0,
      skipped: true,
      elapsedMs: performance.now() - started,
    };

  const result = repairTemplateLinks(identity, template, warn);
  if (result.failed === 0)
    store.run(
      `INSERT INTO identity_link_migrations(agent_id,directory,template) VALUES(?,?,?)
       ON CONFLICT(agent_id) DO UPDATE SET directory=excluded.directory,template=excluded.template`,
      agentId,
      identity,
      template,
    );
  return { ...result, skipped: false };
}
