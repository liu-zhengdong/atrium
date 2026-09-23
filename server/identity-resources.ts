import {
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { defaultTemplate } from "./profile.ts";
import { Problem } from "./store.ts";

const MAX_TEXT = 1024 * 1024;
const skillName = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
const rules = ["AGENTS.md", "SYSTEM.md", "APPEND_SYSTEM.md"] as const;
export type RuleName = (typeof rules)[number];
export type SkillAction = "enable" | "disable" | "remove" | "copy";
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const checkedName = (name: string) => {
  if (!skillName.test(name)) throw new Problem(400, "技能名称无效");
  return name;
};
function safeRoot(dir: string) {
  if (lstatSync(dir).isSymbolicLink())
    throw new Problem(400, "身份目录不能是符号链接");
  return resolve(dir);
}
function safePath(dir: string, ...parts: string[]) {
  const root = safeRoot(dir);
  let path = root;
  for (const part of parts) {
    path = join(path, part);
    if (!path.startsWith(root + sep))
      throw new Problem(400, "路径超出身份目录");
    try {
      if (lstatSync(path).isSymbolicLink())
        throw new Problem(400, "不读写符号链接");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return path;
}
function readText(file: string) {
  if (!existsSync(file)) return "";
  if (!lstatSync(file).isFile() || lstatSync(file).size > MAX_TEXT)
    throw new Problem(400, "文件过大或不是普通文件");
  return readFileSync(file, "utf8");
}
function atomic(file: string, text: string) {
  if (Buffer.byteLength(text) > MAX_TEXT)
    throw new Problem(400, "文件超过 1 MiB");
  if (existsSync(file)) {
    readText(file);
    // Keep backups away from Pi's resource discovery directories.
    const backup = join(
      safeRoot(resolve(file, "..")),
      `.atrium-backup-${randomUUID()}`,
    );
    cpSync(file, backup, { mode: constants.COPYFILE_EXCL, force: false });
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}
function settings(dir: string) {
  const file = safePath(dir, "settings.json");
  const value = JSON.parse(readText(file)) as unknown;
  if (!object(value)) throw new Problem(400, "settings.json 无效");
  return value;
}
function frontmatter(text: string) {
  try {
    const { frontmatter } = parseFrontmatter(text);
    return {
      name: typeof frontmatter.name === "string" ? frontmatter.name : "",
      description:
        typeof frontmatter.description === "string"
          ? frontmatter.description
          : "",
    };
  } catch {
    // A malformed agent-authored skill should not hide the rest of the list.
    return { name: "", description: "" };
  }
}
export function planSkill(
  current: string[],
  action: SkillAction,
  name: string,
) {
  checkedName(name);
  const path = `-skills/${name}/SKILL.md`;
  if (action === "disable")
    return current.includes(path) ? current : [...current, path];
  return current.filter((entry) => entry !== path);
}
function skillDir(dir: string) {
  return safePath(dir, "skills");
}
function skillPath(dir: string, name: string) {
  return safePath(dir, "skills", checkedName(name));
}
function validateSkillTree(root: string, entry = root, total = { bytes: 0 }) {
  const stat = lstatSync(entry);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
    throw new Problem(400, "技能包含链接或特殊文件");
  if (stat.isFile()) total.bytes += stat.size;
  if (total.bytes > 10 * MAX_TEXT) throw new Problem(400, "技能超过 10 MiB");
  if (stat.isDirectory())
    for (const name of readdirSync(entry))
      validateSkillTree(root, join(entry, name), total);
}
export function listSkills(dir: string) {
  const root = skillDir(dir);
  const configured = settings(dir).skills;
  const ignored = new Set(
    (Array.isArray(configured) ? configured : []).filter(
      (v): v is string => typeof v === "string",
    ),
  );
  const skills = existsSync(root) ? readdirSync(root) : [];
  return skills.flatMap((key) => {
    if (!skillName.test(key)) return [];
    const file = safePath(dir, "skills", key, "SKILL.md");
    if (!existsSync(file)) return [];
    const meta = frontmatter(readText(file));
    return [
      {
        key,
        name: meta.name || key,
        description: meta.description,
        enabled: !ignored.has(`-skills/${key}/SKILL.md`),
      },
    ];
  });
}
export function listTemplateSkills(dir: string) {
  const identitySkills = skillDir(dir);
  const installed = new Set(
    existsSync(identitySkills) ? readdirSync(identitySkills) : [],
  );
  const template = safeRoot(defaultTemplate());
  const root = safePath(template, "skills");
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((key) => {
    if (!skillName.test(key) || installed.has(key)) return [];
    try {
      const file = safePath(template, "skills", key, "SKILL.md");
      if (!existsSync(file)) return [];
      const meta = frontmatter(readText(file));
      return [{ key, name: meta.name || key, description: meta.description }];
    } catch (error) {
      if (error instanceof Problem) return [];
      throw error;
    }
  });
}
export function changeSkill(dir: string, action: SkillAction, name: string) {
  const target = skillPath(dir, name);
  const config = settings(dir);
  const current = Array.isArray(config.skills)
    ? config.skills.filter((v): v is string => typeof v === "string")
    : [];
  const next = planSkill(current, action, name);
  if (action === "copy") {
    if (existsSync(target)) throw new Problem(409, "技能已存在");
    const template = safeRoot(defaultTemplate());
    const source = safePath(template, "skills", checkedName(name));
    if (!existsSync(join(source, "SKILL.md")))
      throw new Problem(404, "个人模板没有这个技能");
    validateSkillTree(source);
    mkdirSync(skillDir(dir), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      cpSync(source, temporary, {
        recursive: true,
        mode: constants.COPYFILE_FICLONE,
      });
      renameSync(temporary, target);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  } else {
    if (!existsSync(target)) throw new Problem(404, "技能不存在");
    safePath(dir, "skills", name, "SKILL.md");
    if (action === "remove") {
      // Preserve original contents, including agent-authored files, before removing them from discovery.
      validateSkillTree(target);
      const backup = safePath(dir, `.atrium-skill-${name}-${randomUUID()}`);
      cpSync(target, backup, {
        recursive: true,
        mode: constants.COPYFILE_FICLONE,
      });
      rmSync(target, { recursive: true });
    }
  }
  if (JSON.stringify(current) !== JSON.stringify(next))
    atomic(
      safePath(dir, "settings.json"),
      JSON.stringify({ ...config, skills: next }, null, 2) + "\n",
    );
  return listSkills(dir);
}
export function listRules(dir: string) {
  return rules
    .filter((name) => name === "AGENTS.md" || existsSync(safePath(dir, name)))
    .map((name) => ({ name, text: readText(safePath(dir, name)) }));
}
export function writeRule(dir: string, name: RuleName, text: string) {
  if (!rules.includes(name)) throw new Problem(400, "规则文件名无效");
  if (name !== "AGENTS.md" && !existsSync(safePath(dir, name)))
    throw new Problem(404, "规则文件不存在");
  atomic(safePath(dir, name), text);
  return listRules(dir);
}
const HIDDEN = "********";
function mcpConfig(text: string) {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "";
    const position = /position (\d+)/.exec(detail);
    const location = /line (\d+) column (\d+)/.exec(detail);
    const offset = Math.min(Number(position?.[1] ?? text.length), text.length);
    const before = text.slice(0, offset).split(/\r\n|\r|\n/);
    const line = location ? Number(location[1]) : before.length;
    const column = location ? Number(location[2]) : before.at(-1)!.length + 1;
    throw new Problem(
      400,
      `MCP JSON 格式无效（第 ${line} 行，第 ${column} 列）`,
    );
  }
  if (!object(value) || !object(value.mcpServers))
    throw new Problem(400, "需要 mcpServers 对象");
  for (const [name, server] of Object.entries(value.mcpServers)) {
    if (
      !/^[a-zA-Z0-9][\w.-]{0,127}$/.test(name) ||
      !object(server) ||
      !(
        (typeof server.command === "string" && server.command.trim()) ||
        (typeof server.url === "string" && /^https?:\/\//.test(server.url))
      )
    )
      throw new Problem(400, `MCP 服务器无效：${name}`);
    for (const field of ["env", "headers"])
      if (
        server[field] !== undefined &&
        (!object(server[field]) ||
          Object.values(server[field]).some((v) => typeof v !== "string"))
      )
        throw new Problem(400, `${name} 的 ${field} 无效`);
  }
  return value as Record<string, unknown> & {
    mcpServers: Record<string, Record<string, unknown>>;
  };
}
function redact(config: ReturnType<typeof mcpConfig>) {
  const copy = structuredClone(config);
  for (const server of Object.values(copy.mcpServers))
    for (const key of ["env", "headers"])
      if (object(server[key]))
        for (const name of Object.keys(server[key]))
          (server[key] as Record<string, unknown>)[name] = HIDDEN;
  return copy;
}
export function readMcp(dir: string) {
  const file = safePath(dir, "mcp.json");
  const raw = readText(file);
  const config = raw ? mcpConfig(raw) : mcpConfig('{"mcpServers":{}}');
  return {
    text: JSON.stringify(redact(config), null, 2) + "\n",
    servers: Object.entries(config.mcpServers).map(([name, server]) => ({
      name,
      address:
        typeof server.command === "string"
          ? server.command
          : (server.url as string),
    })),
    builtin: "Atrium MCP 代理",
  };
}
export function writeMcp(dir: string, text: string) {
  if (Buffer.byteLength(text) > MAX_TEXT)
    throw new Problem(400, "文件超过 1 MiB");
  const file = safePath(dir, "mcp.json");
  const next = mcpConfig(text);
  const original = readText(file);
  const previous = original
    ? mcpConfig(original)
    : mcpConfig('{"mcpServers":{}}');
  for (const [name, server] of Object.entries(next.mcpServers))
    for (const field of ["env", "headers"])
      if (object(server[field]))
        for (const [key, value] of Object.entries(server[field]))
          if (value === HIDDEN) {
            const prior = previous.mcpServers[name]?.[field];
            if (!object(prior) || typeof prior[key] !== "string")
              throw new Problem(400, "不能为新凭据使用隐藏占位符");
            (server[field] as Record<string, unknown>)[key] = prior[key];
          }
  atomic(file, JSON.stringify(next, null, 2) + "\n");
  return readMcp(dir);
}
