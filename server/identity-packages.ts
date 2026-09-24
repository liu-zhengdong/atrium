import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, relative, resolve, sep } from "node:path";
import {
  defaultTemplate,
  bundledPackagePath,
  isBundledPackagePath,
  injectBundledPackages,
} from "./profile.ts";
import { templatePackagePath } from "./package-spec.ts";
import { Problem } from "./store.ts";
import { clone } from "./clone.ts";

export type PackageEntry =
  | string
  | {
      source: string;
      extensions?: string[];
      skills?: string[];
      prompts?: string[];
      themes?: string[];
    };
export type PackageAction = {
  action: "add" | "remove" | "update" | "enable" | "disable" | "update-all";
  spec?: string;
};
const resources = ["extensions", "skills", "prompts", "themes"] as const;
const source = (entry: PackageEntry) =>
  typeof entry === "string" ? entry : entry.source;
const settingsPath = (dir: string) => join(dir, "settings.json");
const modePath = (dir: string) => join(dir, ".atrium-packages.json");
const readSettings = (dir: string) =>
  JSON.parse(readFileSync(settingsPath(dir), "utf8")) as Record<
    string,
    unknown
  >;
const entries = (settings: Record<string, unknown>) =>
  (Array.isArray(settings.packages) ? settings.packages : []) as PackageEntry[];
const writeJson = (file: string, value: unknown) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const atomicJson = (file: string, value: unknown) => {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeJson(temp, value);
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
};
const allowedSpec = (value: string) => {
  if (/^npm:(?:@[\w.-]+\/)?[\w.-]+(?:@[^\s/]+)?$/.test(value)) return true;
  if (value.startsWith("git:") && !/\s/.test(value)) {
    try {
      const parsed = templatePackagePath("/tmp/pi-validation", value);
      return parsed.startsWith("/tmp/pi-validation/git/");
    } catch {
      return false;
    }
  }
  return value.startsWith("/") && !value.includes("\n") && existsSync(value);
};
const isBundled = (value: string) =>
  isBundledPackagePath(value) ||
  /^npm:@liuser\/(?:pi-atrium|pi-acp|pi-mcp-adapter|pi-notes)(?:@|$)/.test(
    value,
  );
const shortName = (value: string) =>
  value.startsWith("/")
    ? value.split("/").filter(Boolean).at(-1)!
    : value.replace(/^npm:/, "").replace(/@[^@/]+$/, "");

/** Legacy absolute npm/git paths are mapped to the same installed package, not reinstalled. */
export function ownSource(value: string, template: string): string {
  if (/^(npm:|git:)/.test(value)) return value;
  const npmRoot = join(template, "npm", "node_modules");
  const npmPath = relative(npmRoot, value);
  if (
    npmPath &&
    !npmPath.startsWith(".." + sep) &&
    npmPath !== ".." &&
    !npmPath.startsWith(sep)
  ) {
    const name = npmPath
      .split(sep)
      .slice(0, npmPath.startsWith("@") ? 2 : 1)
      .join("/");
    return `npm:${name}`;
  }
  const gitRoot = join(template, "git");
  const gitPath = relative(gitRoot, value);
  if (
    gitPath &&
    !gitPath.startsWith(".." + sep) &&
    gitPath !== ".." &&
    !gitPath.startsWith(sep)
  ) {
    try {
      const url = execFileSync(
        "git",
        ["-C", value, "config", "--get", "remote.origin.url"],
        { encoding: "utf8", timeout: 5000 },
      ).trim();
      if (url) return `git:${url}`;
    } catch {
      /* A checkout without a remote can still be copied from its installed path. */
    }
    return `git:${gitPath.split(sep).join("/")}`;
  }
  return /^(\/|~\/)/.test(value)
    ? templatePackagePath(template, value)
    : resolve(template, value);
}

/** Pure decision boundary: validate the complete request before touching disk. */
export function planPackages(
  current: PackageEntry[],
  request: PackageAction,
): PackageEntry[] {
  const { action, spec } = request;
  if (action === "update-all") return current;
  if (
    !spec ||
    ((action === "add" || !spec.startsWith("/")) && !allowedSpec(spec)) ||
    isBundled(spec)
  )
    throw new Problem(400, "插件来源无效或为应用内置插件");
  if (spec.startsWith("git:")) templatePackagePath("/tmp", spec);
  const exact = current.findIndex((entry) => source(entry) === spec);
  const at =
    exact !== -1
      ? exact
      : spec.startsWith("npm:")
        ? current.findIndex(
            (entry) =>
              source(entry).startsWith("npm:") &&
              shortName(source(entry)) === shortName(spec),
          )
        : -1;
  if (action === "add") {
    if (at !== -1) throw new Problem(409, "插件已存在");
    return [...current, spec];
  }
  if (at === -1) throw new Problem(404, "插件不存在");
  if (isBundled(source(current[at]!)))
    throw new Problem(400, "不能修改应用内置插件");
  if (action === "remove") return current.filter((_, index) => index !== at);
  if (action === "update") {
    if (!/^(npm:|git:)/.test(source(current[at]!)))
      throw new Problem(400, "本地路径插件不能在线更新");
    return current;
  }
  if (action === "disable")
    return current.map((entry, index) =>
      index === at
        ? {
            source: source(entry),
            ...Object.fromEntries(resources.map((key) => [key, []])),
          }
        : entry,
    );
  if (action === "enable")
    return current.map((entry, index) =>
      index === at ? source(entry) : entry,
    );
  throw new Problem(400, "未知插件操作");
}

export function packageList(directory: string) {
  const settings = readSettings(directory);
  const mode = existsSync(modePath(directory)) ? "own" : "shared";
  return {
    mode,
    packages: entries(settings).map((entry) => {
      const spec = source(entry);
      const classified =
        mode === "shared" ? ownSource(spec, defaultTemplate()) : spec;
      const path = /^(npm:|git:)/.test(spec)
        ? templatePackagePath(directory, spec)
        : spec;
      let version: string | null = null;
      try {
        version =
          (
            JSON.parse(readFileSync(join(path, "package.json"), "utf8")) as {
              version?: string;
            }
          ).version ?? null;
      } catch {
        /* A path can be a single extension. */
      }
      return {
        source: spec,
        name: shortName(classified),
        kind: isBundled(spec)
          ? "bundled"
          : classified.startsWith("npm:")
            ? "npm"
            : classified.startsWith("git:")
              ? "git"
              : "local",
        version,
        enabled:
          typeof entry === "string" ||
          !resources.every(
            (key) => Array.isArray(entry[key]) && entry[key].length === 0,
          ),
      };
    }),
  };
}

/** Stage files beside the identity: failed clone/CLI leaves its live settings and installs intact. */
function staged(directory: string, work: (stage: string) => void) {
  const stage = join(directory, `.packages-${randomUUID()}`);
  mkdirSync(stage, { mode: 0o700 });
  try {
    clone(settingsPath(directory), settingsPath(stage));
    for (const name of ["npm", "git"])
      if (existsSync(join(directory, name)))
        clone(join(directory, name), join(stage, name));
    work(stage);
    const backup = join(stage, "backup");
    mkdirSync(backup);
    const moved: string[] = [];
    let movedMarker = false;
    try {
      for (const name of ["npm", "git"]) {
        if (existsSync(join(directory, name)))
          renameSync(join(directory, name), join(backup, name));
        if (existsSync(join(stage, name))) {
          renameSync(join(stage, name), join(directory, name));
          moved.push(name);
        }
      }
      renameSync(settingsPath(directory), join(backup, "settings.json"));
      renameSync(settingsPath(stage), settingsPath(directory));
      if (existsSync(modePath(stage))) {
        renameSync(modePath(stage), modePath(directory));
        movedMarker = true;
      }
    } catch (error) {
      if (movedMarker) rmSync(modePath(directory), { force: true });
      for (const name of moved)
        rmSync(join(directory, name), { recursive: true, force: true });
      for (const name of ["npm", "git", "settings.json"])
        if (existsSync(join(backup, name)))
          renameSync(join(backup, name), join(directory, name));
      throw error;
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** Clone only referenced git checkouts; npm's install tree includes hoisted dependencies. */
export function cloneTemplatePackages(
  template: string,
  target: string,
  selected: PackageEntry[],
) {
  const own = selected.map((entry) =>
    typeof entry === "string"
      ? ownSource(entry, template)
      : { ...entry, source: ownSource(entry.source, template) },
  );
  const npm = own.some((entry) => source(entry).startsWith("npm:"));
  if (
    npm &&
    existsSync(join(template, "npm")) &&
    !existsSync(join(target, "npm"))
  )
    clone(join(template, "npm"), join(target, "npm"));
  for (const entry of own) {
    const spec = source(entry);
    if (
      spec.startsWith("npm:") &&
      !existsSync(templatePackagePath(target, spec))
    ) {
      if (!existsSync(templatePackagePath(template, spec)))
        throw new Problem(400, `模板 package 未安装：${spec}`);
      const from = templatePackagePath(template, spec),
        to = templatePackagePath(target, spec);
      mkdirSync(resolve(to, ".."), { recursive: true });
      clone(from, to);
    }
  }
  for (const entry of own) {
    const spec = source(entry);
    if (!spec.startsWith("git:")) continue;
    const from = templatePackagePath(template, spec),
      to = templatePackagePath(target, spec);
    if (!existsSync(from))
      throw new Problem(400, `模板 package 未安装：${spec}`);
    mkdirSync(resolve(to, ".."), { recursive: true });
    if (!existsSync(to)) clone(from, to);
  }
  return own;
}

export function prepareOwnPackages(
  template: string,
  target: string,
  selected: PackageEntry[],
) {
  const installed = selected.filter((entry) => {
    const value = ownSource(source(entry), template);
    return (
      !/^(npm:|git:)/.test(value) ||
      existsSync(templatePackagePath(template, value))
    );
  });
  const converted = cloneTemplatePackages(template, target, installed);
  const templateEntries = existsSync(settingsPath(template))
    ? entries(readSettings(template)).map(source)
    : [];
  for (const entry of selected.filter((item) => !installed.includes(item))) {
    const spec = source(entry);
    if (templateEntries.includes(spec))
      throw new Problem(400, `模板 package 未安装：${spec}`);
    if (!allowedSpec(spec) || !/^(npm:|git:)/.test(spec))
      throw new Problem(400, "默认插件来源无效");
    runPi(target, ["install", spec]);
    converted.push(entry);
  }
  return converted;
}

export function changeMode(directory: string, mode: "own" | "shared") {
  const marker = modePath(directory);
  if (mode === "own") {
    if (existsSync(marker)) return packageList(directory);
    const original = readSettings(directory),
      selected = entries(original).filter((entry) => !isBundled(source(entry)));
    staged(directory, (stage) => {
      const converted = cloneTemplatePackages(
        defaultTemplate(),
        stage,
        selected,
      );
      const next = readSettings(stage);
      next.packages = injectBundledPackages(converted);
      writeJson(settingsPath(stage), next);
      writeJson(modePath(stage), { shared: original.packages });
    });
  } else if (existsSync(marker)) {
    const original = JSON.parse(readFileSync(marker, "utf8")) as {
      shared: PackageEntry[] | null;
    };
    const shared = original.shared ?? entries(readSettings(defaultTemplate()));
    const next = readSettings(directory);
    next.packages = injectBundledPackages(shared);
    atomicJson(settingsPath(directory), next);
    rmSync(marker);
  }
  return packageList(directory);
}

export type AgentDefaults = {
  packages: PackageEntry[];
  skills: string[];
  model: { provider: string; model: string } | null;
};
export function agentDefaults(
  data: string,
  template = defaultTemplate(),
): AgentDefaults {
  const file = join(data, "agent-defaults.json");
  return existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as AgentDefaults)
    : templateDefaults(template);
}
export function templateDefaults(template = defaultTemplate()): AgentDefaults {
  const settings = existsSync(settingsPath(template))
    ? readSettings(template)
    : {};
  return {
    packages: entries(settings).filter((entry) => !isBundled(source(entry))),
    skills: existsSync(join(template, "skills"))
      ? readdirSync(join(template, "skills"), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      : [],
    model:
      typeof settings.defaultProvider === "string" &&
      typeof settings.defaultModel === "string"
        ? { provider: settings.defaultProvider, model: settings.defaultModel }
        : null,
  };
}
export function saveAgentDefaults(data: string, defaults: AgentDefaults) {
  for (const entry of defaults.packages)
    if (
      isBundled(source(entry)) ||
      !allowedSpec(ownSource(source(entry), defaultTemplate()))
    )
      throw new Problem(400, "插件来源无效");
  for (const skill of defaults.skills)
    if (
      !/^[^./\\][^/\\]*$/.test(skill) ||
      skill === ".." ||
      !existsSync(join(defaultTemplate(), "skills", skill))
    )
      throw new Problem(400, "模板技能不存在或名称无效");
  atomicJson(join(data, "agent-defaults.json"), defaults);
  return defaults;
}
export function markOwn(directory: string) {
  atomicJson(modePath(directory), { shared: null });
}

const queues = new Map<string, Promise<unknown>>();
export function serialized<T>(
  directory: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(directory) ?? Promise.resolve();
  const result = previous.catch(() => {}).then(work);
  queues.set(directory, result);
  void result
    .finally(() => {
      if (queues.get(directory) === result) queues.delete(directory);
    })
    .catch(() => {});
  return result;
}

export function changePackages(directory: string, action: PackageAction) {
  if (!existsSync(modePath(directory)))
    throw new Problem(409, "请先转为独立安装");
  const current = readSettings(directory),
    selected = planPackages(entries(current), action);
  if (
    ["enable", "disable"].includes(action.action) ||
    (action.action === "remove" && action.spec?.startsWith("/"))
  ) {
    current.packages = selected;
    atomicJson(settingsPath(directory), current);
  } else {
    staged(directory, (stage) => {
      if (action.action === "add" && action.spec)
        runPi(stage, ["install", action.spec]);
      else if (action.action === "remove")
        runPi(stage, ["remove", action.spec!]);
      else if (action.action === "update")
        runPi(stage, ["update", action.spec!]);
      else runPi(stage, ["update", "--extensions"]);
      const next = readSettings(stage);
      next.packages = injectBundledPackages(
        action.action === "add" ? entries(next) : selected,
      );
      writeJson(settingsPath(stage), next);
    });
  }
  return packageList(directory);
}

export function runPi(directory: string, args: string[]) {
  try {
    execFileSync("pi", args, {
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: directory,
        GIT_TERMINAL_PROMPT: "0",
        npm_config_yes: "true",
      },
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const output =
      error && typeof error === "object" && "stderr" in error
        ? String(error.stderr)
        : "";
    const summary = output
      .split("\n")
      .map((line) => line.trim())
      .filter(
        (line) =>
          /^(npm error|fatal:|error:)/i.test(line) &&
          !/log of this run|^error: npm (install|uninstall)/i.test(line),
      )
      .slice(0, 2)
      .join("；")
      .replace(/(?:https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "https://***@")
      .replace(args.at(-1) ?? "", "[来源]")
      .replace(
        /(token|password|api[_-]?key|authorization)[=: ]+[^\s;]+/gi,
        "$1=***",
      )
      .slice(0, 250);
    throw new Problem(
      400,
      `插件操作失败；原配置未改变${summary ? `：${summary}` : ""}`,
    );
  }
}
