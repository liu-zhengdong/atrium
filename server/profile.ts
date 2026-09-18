import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

/** Small owned settings; installed code and shared rules are references, never credential copies. */
export function prepareProfile(
  data: string,
  identityId: string,
  template = defaultTemplate(),
) {
  template = realpathSync(template);
  const target = join(data, "agents", identityId);
  if (existsSync(target)) throw new Problem(409, "身份配置目录已存在，未覆盖");
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
    const npm = /^npm:((?:@[^/]+\/)?[^@/]+)(?:@.+)?$/.exec(value);
    if (value.startsWith("git:") || /^https?:/.test(value))
      throw new Problem(400, "模板中的 Git package 请改用已安装的本地路径");
    const path = realpathSync(
      npm
        ? join(template, "npm", "node_modules", npm[1]!)
        : local(value, template),
    );
    return typeof entry === "string"
      ? path
      : { ...(entry as object), source: path };
  });
  // The identity launcher and loaded extension must be from the same supported package.
  const bridge = dirname(require.resolve("@liuser/pi-acp/package.json"));
  settings.packages = references.filter((entry) => {
    const path = typeof entry === "string" ? entry : entry.source;
    return (
      !existsSync(join(path, "package.json")) ||
      readJson(join(path, "package.json")).name !== "@liuser/pi-acp"
    );
  });
  (settings.packages as unknown[]).push(bridge);
  for (const kind of ["extensions", "skills", "prompts", "themes"] as const) {
    const extra = Array.isArray(source[kind]) ? (source[kind] as string[]) : [];
    settings[kind] = extra.map((path) => {
      const prefix = /^[!+-]/.test(path) ? path[0]! : "";
      return prefix + local(prefix ? path.slice(1) : path, template);
    });
    if (existsSync(join(template, kind)))
      (settings[kind] as string[]).push(join(template, kind));
  }
  // MCP/model/rule files remain explicit shared inputs. Credential files and session
  // history are never copied; writable settings belong to the named identity.
  mkdirSync(target, { recursive: true, mode: 0o700 });
  try {
    mkdirSync(join(target, "sessions"), { mode: 0o700 });
    write(join(target, "identity.json"), { version: 1, identityId });
    write(join(target, "settings.json"), settings);
    for (const name of [
      "AGENTS.md",
      "SYSTEM.md",
      "APPEND_SYSTEM.md",
      "models.json",
      "mcp.json",
    ])
      if (existsSync(join(template, name)))
        symlinkSync(join(template, name), join(target, name));
    if (existsSync(join(template, "notes.json"))) {
      const notes = readJson(join(template, "notes.json"));
      const directory =
        typeof notes.directory === "string"
          ? local(notes.directory, template)
          : null;
      write(join(target, "notes.json"), {
        directory,
        ...(notes.maxContextBytes === undefined
          ? {}
          : { maxContextBytes: notes.maxContextBytes }),
      });
    }
    return target;
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    throw error;
  }
}
