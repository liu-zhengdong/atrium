import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
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
const inside = (root: string, path: string) => {
  const base = realpathSync(root);
  const target = realpathSync(path);
  return target === base || target.startsWith(base + sep);
};

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
    for (const name of [
      "AGENTS.md",
      "SYSTEM.md",
      "APPEND_SYSTEM.md",
      "models.json",
      "mcp.json",
    ])
      if (existsSync(join(template, name))) {
        const dest = join(target, name);
        copyOwned(join(template, name), dest);
        created.push(dest);
      }
    if (existsSync(join(template, "notes.json"))) {
      const notes = readJson(join(template, "notes.json"));
      const sourceDir =
        typeof notes.directory === "string"
          ? local(notes.directory, template)
          : null;
      const directory = join(target, "notes");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      created.push(directory);
      if (sourceDir && existsSync(sourceDir)) {
        if (inside(template, sourceDir))
          cpSync(sourceDir, directory, {
            recursive: true,
            dereference: true,
          });
        else
          for (const name of ["USER.md", "USER-Evolution.md"])
            if (existsSync(join(sourceDir, name)))
              copyOwned(join(sourceDir, name), join(directory, name));
      }
      write(join(target, "notes.json"), {
        directory,
        ...(notes.maxContextBytes === undefined
          ? {}
          : { maxContextBytes: notes.maxContextBytes }),
      });
      created.push(join(target, "notes.json"));
    }
    return target;
  } catch (error) {
    for (const path of created) rmSync(path, { recursive: true, force: true });
    throw error;
  }
}
