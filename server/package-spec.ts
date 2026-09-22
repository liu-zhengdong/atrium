import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Problem } from "./store.ts";

/**
 * Paths inside a Pi config are written either as `~/…` or relative to the
 * config directory. Package specs and settings resource paths both read this
 * way, so resolving them lives here.
 */
export const local = (path: string, root: string) =>
  path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(root, path);

const dropGitSuffix = (path: string) =>
  path
    .replace(/\.git$/i, "")
    .replace(/#.*$/, "")
    .replace(/\/+$/, "");

/** Map a Pi/npm git specifier to host + repo path (no ref). */
export function parseGitPackage(
  value: string,
): { host: string; path: string } | null {
  const github = /^github:([^#]+)/.exec(value);
  if (github) {
    const [owner, repo] = dropGitSuffix(github[1]!).split("/");
    if (owner && repo)
      return { host: "github.com", path: `${owner}/${repo.split("@")[0]}` };
    return null;
  }
  const spec = value.startsWith("git:") ? value.slice(4) : value;
  const ssh = /^git@([^:]+):(.+)$/.exec(spec);
  if (ssh) {
    return { host: ssh[1]!, path: dropGitSuffix(ssh[2]!).split("@")[0]! };
  }
  const proto = /^(?:https|http|ssh|git):\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/.exec(
    spec,
  );
  if (proto) {
    return { host: proto[1]!, path: dropGitSuffix(proto[2]!).split("@")[0]! };
  }
  if (value.startsWith("git:")) {
    const short = /^([^/]+)\/(.+)$/.exec(spec);
    if (short) {
      return { host: short[1]!, path: dropGitSuffix(short[2]!).split("@")[0]! };
    }
  }
  return null;
}

/** Where Pi would have installed this package under the template agent dir. */
export function templatePackagePath(template: string, spec: string): string {
  const value = spec.trim();
  const npm = /^npm:((?:@[^/]+\/)?[^@/]+)(?:@.+)?$/.exec(value);
  if (npm) return join(template, "npm", "node_modules", npm[1]!);
  const git = parseGitPackage(value);
  if (git) return join(template, "git", git.host, ...git.path.split("/"));
  if (
    value.startsWith("git:") ||
    value.startsWith("github:") ||
    /^(https?|ssh):\/\//.test(value)
  )
    throw new Problem(400, `无法解析 Git package：${value}`);
  return local(value, template);
}

/** The spec's real install path, or a refusal naming the spec that is missing. */
export function resolveInstalled(template: string, spec: string) {
  const path = templatePackagePath(template, spec);
  try {
    return realpathSync(path);
  } catch {
    throw new Problem(400, `模板 package 未安装：${spec}`);
  }
}
