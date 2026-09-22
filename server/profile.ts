import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { Problem } from "./store.ts";
const require = createRequire(import.meta.url);
export const defaultTemplate = () =>
  resolve(
    process.env.ATRIUM_PI_TEMPLATE ??
      process.env.PI_CODING_AGENT_DIR ??
      join(homedir(), ".pi/agent"),
  );
const readJson = (path: string) =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
const write = (path: string, value: unknown) =>
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
const local = (path: string, root: string) =>
  path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(root, path);
const copyOwned = (from: string, to: string) =>
  writeFileSync(to, readFileSync(realpathSync(from)));
const linked = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};
/** Containment test; a path with nothing on disk is compared as written. */
const inside = (root: string, path: string) => {
  const base = realpathSync(root);
  let target = resolve(path);
  try {
    target = realpathSync(target);
  } catch {
    // Absent: the literal path already says where it would land.
  }
  return target === base || target.startsWith(base + sep);
};
/** Notes an identity keeps for itself; the rest of a personal vault stays put. */
const OWNED_NOTES = ["USER", "self-evolution"];
/** Rule, model and MCP files an identity keeps as its own copies. */
const OWNED_FILES = [
  "AGENTS.md",
  "SYSTEM.md",
  "APPEND_SYSTEM.md",
  "models.json",
  "mcp.json",
];
const notesSettings = (directory: string, maxContextBytes: unknown) => ({
  directory,
  ...(maxContextBytes === undefined ? {} : { maxContextBytes }),
});
const notesDirectory = (notes: Record<string, unknown>, root: string) =>
  typeof notes.directory === "string" ? local(notes.directory, root) : null;
/**
 * Copy the owned notes the identity lacks; copies it already has are kept.
 * Each note brings its Evolution log and its same-named folder of sub-notes.
 */
function copyOwnedNotes(sourceDir: string, directory: string) {
  for (const base of OWNED_NOTES)
    for (const name of [`${base}.md`, `${base}-Evolution.md`, base]) {
      const from = join(sourceDir, name),
        dest = join(directory, name);
      if (!existsSync(from) || existsSync(dest)) continue;
      if (statSync(from).isDirectory())
        cpSync(from, dest, { recursive: true, dereference: true });
      else copyOwned(from, dest);
    }
}
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
const resolveInstalled = (template: string, spec: string) => {
  const path = templatePackagePath(template, spec);
  try {
    return realpathSync(path);
  } catch {
    throw new Problem(400, `模板 package 未安装：${spec}`);
  }
};

const BUNDLED_PACKAGE_NAMES = new Set([
  "@liuser/pi-atrium",
  "@liuser/pi-acp",
  "@liuser/pi-mcp-adapter",
  "@liuser/pi-notes",
]);

const BUNDLED_PACKAGE_PATH =
  /(?:^|\/)(?:@liuser\/)?(?:pi-atrium|pi-acp|pi-mcp-adapter|pi-notes)(?:\/|$)/;

function packageNameAt(path: string): string | undefined {
  try {
    const name = readJson(join(path, "package.json")).name;
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}

function entryPath(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && "source" in entry) {
    const source = (entry as { source: unknown }).source;
    return typeof source === "string" ? source : undefined;
  }
  return undefined;
}

/** Paths that are this app's Pi bundle, including stale pi-acp / adapter / notes. */
export function isBundledPackagePath(path: string): boolean {
  const name = packageNameAt(path);
  if (name && BUNDLED_PACKAGE_NAMES.has(name)) return true;
  return BUNDLED_PACKAGE_PATH.test(path.replaceAll("\\", "/"));
}

export function bundledPackagePath(): string {
  return dirname(require.resolve("@liuser/pi-atrium/package.json"));
}

/** Keep user packages; replace any bundled copy with the current app install. */
export function injectBundledPackages(packages: unknown[]): unknown[] {
  const bridge = bundledPackagePath();
  const kept: unknown[] = [];
  for (const entry of packages) {
    const path = entryPath(entry);
    if (path === undefined) {
      kept.push(entry);
      continue;
    }
    if (isBundledPackagePath(path)) continue;
    kept.push(entry);
  }
  kept.push(bridge);
  return kept;
}

/** Rewrite an existing identity's settings before Pi loads packages. */
export function syncIdentityPackages(directory: string) {
  const file = join(directory, "settings.json");
  if (!existsSync(file)) return;
  const settings = readJson(file);
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  const next = injectBundledPackages(packages);
  if (JSON.stringify(packages) === JSON.stringify(next)) return;
  settings.packages = next;
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", {
    mode: 0o600,
  });
}

/** Add owned notes an identity predates. Its own copies win; no overwrite. */
export function syncIdentityNotes(
  directory: string,
  template = defaultTemplate(),
) {
  const own = join(directory, "notes.json");
  const source = join(template, "notes.json");
  if (!existsSync(own) || !existsSync(source)) return;
  // Only ever write into the notes directory this app laid out for the identity.
  const target = notesDirectory(readJson(own), directory);
  if (target !== join(directory, "notes")) return;
  const sourceDir = notesDirectory(readJson(source), template);
  if (!sourceDir || !existsSync(sourceDir)) return;
  mkdirSync(target, { recursive: true, mode: 0o700 });
  copyOwnedNotes(sourceDir, target);
}

/**
 * Profiles made before this layout symlinked their rules into the user's global
 * config: the Agent rewriting a rule rewrote the user's file, and the user's
 * edits changed the Agent. Replace each link with its content; the rename keeps
 * the link in place until the copy is whole.
 */
function adoptLinkedFiles(directory: string) {
  const failed: string[] = [];
  for (const name of OWNED_FILES) {
    const path = join(directory, name);
    if (!linked(path)) continue;
    const staging = `${path}.adopting`;
    try {
      writeFileSync(staging, readFileSync(realpathSync(path)));
      renameSync(staging, path);
    } catch {
      rmSync(staging, { force: true });
      failed.push(name);
    }
  }
  return failed;
}

/**
 * Notes pointed outside the identity (an early profile aimed straight at the
 * user's vault) move to its own directory. Only the notes it owns come along;
 * the vault itself is read, never written.
 */
function adoptNotesDirectory(directory: string) {
  const file = join(directory, "notes.json");
  if (!existsSync(file)) return;
  const notes = readJson(file);
  const current = notesDirectory(notes, directory);
  if (!current || inside(directory, current)) return;
  const target = join(directory, "notes");
  // A linked notes dir would make the copy below land back in the vault.
  if (linked(target)) throw new Problem(409, "notes 目录是符号链接，未改动");
  mkdirSync(target, { recursive: true, mode: 0o700 });
  if (existsSync(current)) copyOwnedNotes(current, target);
  writeFileSync(
    file,
    JSON.stringify(notesSettings(target, notes.maxContextBytes), null, 2) +
      "\n",
    { mode: 0o600 },
  );
}

/** Turn an old profile's shared rules and vault into this identity's own copies. */
export function adoptIdentityConfig(directory: string) {
  const failed = adoptLinkedFiles(directory);
  adoptNotesDirectory(directory);
  if (failed.length)
    throw new Problem(500, `规则文件未能复制：${failed.join("、")}`);
}

/**
 * Bring a profile up to the current layout before Pi reads it, from every start
 * path. The bundled packages must land — without them the identity has no
 * bridge; the rest is best effort and returns what the caller should report.
 */
export function syncIdentityProfile(directory: string) {
  syncIdentityPackages(directory);
  const notices: string[] = [];
  const steps: [string, () => void][] = [
    ["配置未能转成自有副本", () => adoptIdentityConfig(directory)],
    ["协议笔记未能补齐", () => syncIdentityNotes(directory)],
  ];
  for (const [label, run] of steps)
    try {
      run();
    } catch (error) {
      notices.push(`${label}：${error}`);
    }
  return notices;
}

/** Owned rules and notes; installed extensions/skills stay as path references. Never copy credentials. */
export function prepareProfile(
  identityId: string,
  template = defaultTemplate(),
  piHome: string,
) {
  template = realpathSync(template);
  const target = join(piHome, "atrium", "agents", identityId);
  // A legacy record's directory may already hold its managed session and logs;
  // identity.json marks a prepared profile, any other existing content is kept.
  if (existsSync(join(target, "identity.json")))
    throw new Problem(409, "身份配置目录已存在，未覆盖");
  const source = existsSync(join(template, "settings.json"))
    ? readJson(join(template, "settings.json"))
    : {};
  const settings: Record<string, unknown> = {};
  for (const key of [
    "defaultProvider",
    "defaultModel",
    "defaultThinkingLevel",
    "theme",
    "hideThinkingBlock",
    "compaction",
    "retry",
    "transport",
    "enabledModels",
    "thinkingBudgets",
    "defaultTools",
  ])
    if (source[key] !== undefined) settings[key] = source[key];
  const packages = Array.isArray(source.packages) ? source.packages : [];
  const references = packages.map((entry: unknown) => {
    const value =
      typeof entry === "string" ? entry : (entry as { source: string }).source;
    if (typeof value !== "string")
      throw new Problem(400, "配置模板含无效 package");
    const path = resolveInstalled(template, value);
    return typeof entry === "string"
      ? path
      : { ...(entry as object), source: path };
  });
  settings.packages = injectBundledPackages(references);
  for (const kind of ["extensions", "skills", "prompts", "themes"] as const) {
    const extra = Array.isArray(source[kind]) ? (source[kind] as string[]) : [];
    settings[kind] = extra.map((path) => {
      const prefix = /^[!+-]/.test(path) ? path[0]! : "";
      return prefix + local(prefix ? path.slice(1) : path, template);
    });
    if (existsSync(join(template, kind)))
      (settings[kind] as string[]).push(join(template, kind));
  }
  // Rule/model/MCP files and notes become this identity's own copies.
  // Credential files and session history are never copied.
  // Identity files are written exclusively (wx) alongside kept legacy content;
  // on failure only what this call created is removed.
  const created: string[] = [];
  mkdirSync(target, { recursive: true, mode: 0o700 });
  try {
    const sessions = join(target, "sessions");
    if (!existsSync(sessions)) {
      mkdirSync(sessions, { mode: 0o700 });
      created.push(sessions);
    }
    write(join(target, "identity.json"), { version: 1, identityId });
    created.push(join(target, "identity.json"));
    write(join(target, "settings.json"), settings);
    created.push(join(target, "settings.json"));
    for (const name of OWNED_FILES)
      if (existsSync(join(template, name))) {
        const dest = join(target, name);
        copyOwned(join(template, name), dest);
        created.push(dest);
      }
    if (existsSync(join(template, "notes.json"))) {
      const notes = readJson(join(template, "notes.json"));
      const sourceDir = notesDirectory(notes, template);
      const directory = join(target, "notes");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      created.push(directory);
      if (sourceDir && existsSync(sourceDir)) {
        if (inside(template, sourceDir))
          cpSync(sourceDir, directory, {
            recursive: true,
            dereference: true,
          });
        else copyOwnedNotes(sourceDir, directory);
      }
      write(
        join(target, "notes.json"),
        notesSettings(directory, notes.maxContextBytes),
      );
      created.push(join(target, "notes.json"));
    }
    return target;
  } catch (error) {
    for (const path of created) rmSync(path, { recursive: true, force: true });
    throw error;
  }
}
