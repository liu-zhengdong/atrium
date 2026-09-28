import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path, { dirname, join } from "node:path";
import { linkPath } from "../platform/index.ts";
import { ADAPTERS, type Tool } from "../tasks/adapters/index.ts";
import type { Files } from "./model.ts";
import type { TaskSkill } from "./task-skills.ts";

/**
 * 派活时把技能拷到任务目录（#264 第 3b 步）：只对这一次运行生效，不写用户全局配置、不写仓库工作树，
 * 任务目录随任务清理，不用卸载。按工具交给执行者（本机版本实测）：
 * - Claude Code：`--plugin-dir <任务目录>/skills-plugin`，技能在插件的 skills/ 下；
 * - codex：`CODEX_HOME=<任务目录>/codex-home`，技能在其 skills/ 下；auth.json、config.toml、AGENTS.md、rules、plugins
 *   与用户自己的 ~/.codex/skills/* 软链回原处（同名以组织技能为准），登录、全局约定和用户技能照旧；
 * - opencode：`OPENCODE_CONFIG_DIR=<任务目录>/opencode`，技能在其 skills/ 下，与用户全局配置叠加；
 * - 其他：拷到 <任务目录>/skills/，提示词里给简介和绝对路径，按需读。
 * 每次拉起都按当前修订重写副本。
 * 远程主机（t232）由那台的代理调同一个函数挂在它的任务目录里（server/agent/launch.ts），链接走平台层
 * （Windows 建不了软链时目录用 junction、文件用硬链接）。
 */

/** 挂载要用到的技能字段（远程派活随指令下发的也是这些，t232）。 */
export type MountSkill = Pick<
  TaskSkill,
  "id" | "slug" | "rev" | "description" | "via" | "files"
>;

export type Mounted = {
  id: number;
  slug: string;
  rev: number;
  dir: string;
};
export type Mount = {
  env: Record<string, string>;
  args: string[];
  /** 提示词里的「本次挂载的技能」段。 */
  section: string;
  skills: Mounted[];
};

const CODEX_LINKS = [
  "auth.json",
  "config.toml",
  "AGENTS.md",
  "rules",
  "plugins",
];

export type Layout = {
  root: string;
  skills: string;
  args: string[];
  env: Record<string, string>;
  how: string;
};

/** 按工具放在任务目录的哪里、怎么交给执行者；join 缺省按本机平台（测试可传 path.win32 看 Windows 上的路径）。 */
export function skillLayout(
  dir: string,
  tool: Tool,
  join: (...parts: string[]) => string = path.join,
): Layout {
  switch (ADAPTERS[tool].skillMount) {
    case "claude-plugin": {
      const root = join(dir, "skills-plugin");
      return {
        root,
        skills: join(root, "skills"),
        args: ["--plugin-dir", root],
        env: {},
        how: "已作为 Claude Code 插件技能加载（名字带 atrium-skills: 前缀）",
      };
    }
    case "codex-home": {
      const root = join(dir, "codex-home");
      return {
        root,
        skills: join(root, "skills"),
        args: [],
        env: { CODEX_HOME: root },
        how: "已放进 codex 的技能目录",
      };
    }
    case "opencode-config": {
      const root = join(dir, "opencode");
      return {
        root,
        skills: join(root, "skills"),
        args: [],
        env: { OPENCODE_CONFIG_DIR: root },
        how: "已放进 opencode 的技能目录",
      };
    }
    default:
      return {
        root: join(dir, "skills"),
        skills: join(dir, "skills"),
        args: [],
        env: {},
        how: "没有原生加载，需要时读对应的 SKILL.md",
      };
  }
}

function writeFiles(target: string, files: Files) {
  rmSync(target, { recursive: true, force: true });
  for (const [path, content] of Object.entries(files)) {
    const file = join(target, ...path.split("/"));
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, content, { mode: 0o600 });
  }
}

function linkIfAbsent(source: string, target: string) {
  if (!existsSync(source)) return;
  try {
    lstatSync(target);
  } catch {
    linkPath(source, target);
  }
}

function linkCodexHome(
  root: string,
  home: string,
  skills: readonly MountSkill[],
) {
  const user = join(home, ".codex");
  for (const name of CODEX_LINKS)
    linkIfAbsent(join(user, name), join(root, name));
  let own: string[] = [];
  try {
    own = readdirSync(join(user, "skills"));
  } catch {
    // 用户没有自己的 codex 技能。
  }
  for (const name of own)
    if (!name.startsWith(".") && !skills.some((s) => s.slug === name))
      linkIfAbsent(join(user, "skills", name), join(root, "skills", name));
}

/** 挂载；没有技能时什么都不做，派活与以前完全一样。 */
export function mountSkills(
  dir: string,
  tool: Tool,
  skills: readonly MountSkill[],
  home: string,
): Mount | undefined {
  if (!skills.length) return undefined;
  const place = skillLayout(dir, tool);
  mkdirSync(place.skills, { recursive: true, mode: 0o700 });
  if (ADAPTERS[tool].skillMount === "claude-plugin") {
    mkdirSync(join(place.root, ".claude-plugin"), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(
      join(place.root, ".claude-plugin", "plugin.json"),
      `${JSON.stringify({ name: "atrium-skills", description: "Atrium 派活时挂载的组织技能", version: "1.0.0" }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  if (ADAPTERS[tool].skillMount === "codex-home")
    linkCodexHome(place.root, home, skills);
  const mounted: Mounted[] = skills.map((skill) => {
    const target = join(place.skills, skill.slug);
    writeFiles(target, skill.files);
    return { id: skill.id, slug: skill.slug, rev: skill.rev, dir: target };
  });
  const byslug = new Map(skills.map((skill) => [skill.slug, skill]));
  const section = [
    `以下技能由组织维护，只对这次运行生效；${place.how}。`,
    ...mounted.map((entry) => {
      const skill = byslug.get(entry.slug)!;
      return `- ${entry.slug}（r${entry.rev}，来自 ${skill.via}）：${skill.description}\n  文件：${join(entry.dir, "SKILL.md")}`;
    }),
    "技能内容有误或过时：不要改副本，在交付说明里写明哪条过时、为什么。",
  ].join("\n");
  return { env: place.env, args: place.args, section, skills: mounted };
}
