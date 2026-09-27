import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ADAPTERS, type Tool } from "../tasks/adapters/index.ts";
import { LIMITS, type Files } from "./model.ts";
import type { TaskSkill } from "./task-skills.ts";

/**
 * 派活时把技能拷到任务目录（#264 第 3b 步）：只对这一次运行生效，不写用户全局配置、不写仓库工作树，
 * 任务目录随任务清理，不用卸载。按工具交给执行者（本机版本实测）：
 * - Claude Code：`--plugin-dir <任务目录>/skills-plugin`，技能在插件的 skills/ 下；
 * - codex：`CODEX_HOME=<任务目录>/codex-home`，技能在其 skills/ 下；auth.json、config.toml、AGENTS.md、rules、plugins
 *   与用户自己的 ~/.codex/skills/* 软链回原处（同名以组织技能为准），登录、全局约定和用户技能照旧；
 * - opencode：`OPENCODE_CONFIG_DIR=<任务目录>/opencode`，技能在其 skills/ 下，与用户全局配置叠加；
 * - 其他：拷到 <任务目录>/skills/，提示词里给简介和绝对路径，按需读。
 * 同一任务再次拉起（重试、换人）时已挂的副本原样保留，执行者上一轮的改动不会被覆盖。
 */

export const MANIFEST = "skills.json";
export const NOTES = "skill-notes.md";

export type Mounted = { id: number; slug: string; rev: number; dir: string };
export type Manifest = { skills: Mounted[] };
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

type Layout = {
  root: string;
  skills: string;
  args: string[];
  env: Record<string, string>;
  how: string;
};

function layout(dir: string, tool: Tool): Layout {
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

export function readManifest(dir: string): Manifest | undefined {
  try {
    const data = JSON.parse(
      readFileSync(join(dir, MANIFEST), "utf8"),
    ) as Manifest;
    return Array.isArray(data.skills) ? data : undefined;
  } catch {
    return undefined;
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
    symlinkSync(source, target);
  }
}

function linkCodexHome(
  root: string,
  home: string,
  skills: readonly TaskSkill[],
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
  skills: readonly TaskSkill[],
  home: string,
): Mount | undefined {
  if (!skills.length) return undefined;
  const place = layout(dir, tool);
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
  const previous = new Map(
    (readManifest(dir)?.skills ?? []).map((entry) => [entry.slug, entry]),
  );
  const mounted: Mounted[] = [];
  for (const skill of skills) {
    const target = join(place.skills, skill.slug);
    const kept = previous.get(skill.slug);
    if (kept && kept.dir === target && existsSync(join(target, "SKILL.md"))) {
      mounted.push(kept);
      continue;
    }
    writeFiles(target, skill.files);
    mounted.push({
      id: skill.id,
      slug: skill.slug,
      rev: skill.rev,
      dir: target,
    });
  }
  // 上一轮挂过、这轮不再用的副本（不再带，或换了执行者、目录不同）也留在清单里，收尾照样比对，免得改动丢失。
  const all = [
    ...mounted,
    ...(readManifest(dir)?.skills ?? []).filter(
      (entry) => !mounted.some((m) => m.dir === entry.dir),
    ),
  ];
  writeFileSync(
    join(dir, MANIFEST),
    `${JSON.stringify({ skills: all }, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  const byslug = new Map(skills.map((skill) => [skill.slug, skill]));
  const section = [
    `以下技能由组织维护，只对这次运行生效；${place.how}。`,
    ...mounted.map((entry) => {
      const skill = byslug.get(entry.slug)!;
      return `- ${entry.slug}（r${entry.rev}，来自 ${skill.via}）：${skill.description}\n  文件：${join(entry.dir, "SKILL.md")}`;
    }),
    `技能内容有误或过时：可以直接改上面的副本（不要复制进仓库），并把原因写进 ${join(dir, NOTES)}；收尾时会生成修订提议，审核后采纳。`,
  ].join("\n");
  return { env: place.env, args: place.args, section, skills: mounted };
}

/** 读回挂载副本：跳过隐藏文件和符号链接，超出上限就停下报告。 */
export function readMounted(
  root: string,
): { files: Files } | { problem: string } {
  const files: Files = {};
  let bytes = 0;
  const walk = (
    dir: string,
    prefix: string,
    depth: number,
  ): string | undefined => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return `读不到 ${dir}`;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth >= LIMITS.depth) return `${rel} 目录层级超过 ${LIMITS.depth}`;
        const problem = walk(full, rel, depth + 1);
        if (problem) return problem;
      } else if (entry.isFile()) {
        if (Object.keys(files).length >= LIMITS.files)
          return `文件超过 ${LIMITS.files} 个`;
        const size = lstatSync(full).size;
        bytes += size;
        if (bytes > LIMITS.bytes) return `合计超过 ${LIMITS.bytes / 1024} KB`;
        files[rel] = readFileSync(full, "utf8");
      }
    }
    return undefined;
  };
  const problem = walk(root, "", 1);
  return problem ? { problem } : { files };
}
