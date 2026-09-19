import {
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { defaultTemplate, prepareProfile } from "./profile.ts";
import { dirname, join, resolve, sep } from "node:path";
import { displayName } from "../shared/schema.ts";
import { Store, Problem } from "./store.ts";

/** ~/.pi unless tests pass piHome / ATRIUM_PI_HOME. */
export function resolvePiHome(explicit?: string) {
  if (explicit) return resolve(explicit);
  if (process.env.ATRIUM_PI_HOME) return resolve(process.env.ATRIUM_PI_HOME);
  if (process.env.NODE_TEST_CONTEXT)
    throw new Problem(500, "测试须指定 piHome，避免写入 ~/.pi");
  return resolve(join(homedir(), ".pi"));
}

/** Named alias directory: ~/.pi/agents/<name> → atrium/agents/<uuid>. */
export const profileLinks = (piHome: string) => join(piHome, "agents");

/** Root of the fixed per-identity workspaces; each Agent gets ~/atrium/desktops/<name>. */
export const defaultDesktops = () =>
  process.env.ATRIUM_DESKTOPS ?? join(homedir(), "atrium", "desktops");

/** Display form of the desktops root, collapsing the home directory to ~. */
export const displayDesktops = (root: string) => {
  const home = homedir();
  return root === home
    ? "~"
    : root.startsWith(home + sep)
      ? `~${root.slice(home.length)}`
      : root;
};

const hasEntry = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

function childPath(root: string, name: string, label: string) {
  const base = resolve(root);
  const target = resolve(base, name);
  if (name === "." || name === ".." || dirname(target) !== base)
    throw new Problem(400, `名称不能作为${label}`);
  return target;
}

/** The desktop is created at identity creation and reused as cwd on every start. */
export function desktopDirectory(root: string, name: string) {
  const target = childPath(root, name, "工作目录");
  if (hasEntry(target))
    throw new Problem(
      409,
      "工作目录已存在；删除身份时会保留桌面，请换名或先处理该目录",
    );
  try {
    mkdirSync(target, { recursive: true });
  } catch {
    throw new Problem(409, "无法创建工作目录，目标路径可能被文件占用");
  }
  return realpathSync(target);
}

function isDirectory(path: string) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** If the recorded workspace is gone, reuse or recreate ~/Atrium/<name>. */
export function ensureDesktopCwd(
  store: Store,
  desktops: string,
  agent: { id: string; name: string; cwd: string },
) {
  if (isDirectory(agent.cwd)) return agent.cwd;
  const target = childPath(desktops, agent.name, "工作目录");
  if (hasEntry(target) && !isDirectory(target))
    throw new Problem(409, "无法创建工作目录，目标路径可能被文件占用");
  try {
    mkdirSync(target, { recursive: true });
  } catch {
    throw new Problem(409, "无法创建工作目录，目标路径可能被文件占用");
  }
  const cwd = realpathSync(target);
  if (cwd !== agent.cwd)
    store.run("UPDATE agents SET cwd=? WHERE id=?", cwd, agent.id);
  return cwd;
}

export function profileLinkPath(piHome: string, name: string) {
  return childPath(profileLinks(piHome), name, "配置入口");
}

export function linkProfile(piHome: string, name: string, canonical: string) {
  mkdirSync(profileLinks(piHome), { recursive: true, mode: 0o700 });
  const link = profileLinkPath(piHome, name);
  if (hasEntry(link)) throw new Problem(409, "这个名称的配置入口还在");
  symlinkSync(canonical, link);
  return link;
}

/** Rename only the named alias; the UUID directory and desktop stay put. */
export function retargetProfileLink(
  piHome: string,
  from: string,
  to: string,
  canonical: string,
) {
  if (from === to) return;
  const dest = profileLinkPath(piHome, to);
  if (hasEntry(dest)) throw new Problem(409, "这个名称的配置入口还在");
  mkdirSync(profileLinks(piHome), { recursive: true, mode: 0o700 });
  const src = profileLinkPath(piHome, from);
  try {
    if (lstatSync(src).isSymbolicLink()) {
      renameSync(src, dest);
      return;
    }
  } catch {
    // Missing or not a link: create a fresh alias.
  }
  symlinkSync(canonical, dest);
}

export function unlinkProfile(piHome: string, name: string) {
  try {
    const link = profileLinkPath(piHome, name);
    if (lstatSync(link).isSymbolicLink()) unlinkSync(link);
  } catch {
    // Missing alias is fine.
  }
}

export type ForkSource = {
  id: string;
  kind: "preset" | "agent";
  name: string;
  tag: string;
  description: string;
};

/** Recruit list: built-in type plus living identities. Presets are not chat peers. */
export function listForkSources(store: Store, query = ""): ForkSource[] {
  const items: ForkSource[] = [
    {
      id: "builtin",
      kind: "preset",
      name: "内置",
      tag: "内置",
      description: "默认配置类型",
    },
    ...store
      .agents()
      .filter((agent) => agent.agent_directory)
      .map((agent) => ({
        id: agent.name,
        kind: "agent" as const,
        name: agent.name,
        tag: "已有",
        description: agent.description,
      })),
  ];
  const q = query.trim().toLowerCase();
  return q
    ? items.filter((item) =>
        `${item.id} ${item.name} ${item.description}`.toLowerCase().includes(q),
      )
    : items;
}

export function resolveProfileTemplate(
  store: Store,
  options: { template?: string; source?: string } = {},
) {
  const source = options.source?.trim();
  if (options.template) {
    if (source && source !== "builtin")
      throw new Problem(400, "不要同时指定来源身份和模板路径");
    return options.template;
  }
  if (!source || source === "builtin") return defaultTemplate();
  const agent = store.agent(store.resolveAgentId(source));
  if (!agent.agent_directory)
    throw new Problem(400, "旧记录不能作为 fork 来源");
  return agent.agent_directory;
}

/** User-facing creation: assigns the identity's fixed desktop workspace. */
export function createAgent(
  store: Store,
  data: string,
  name: string,
  desktops: string,
  options: {
    template?: string;
    source?: string;
    description?: string;
    piHome?: string;
  } = {},
) {
  const parsed = displayName.safeParse(name);
  if (!parsed.success)
    throw new Problem(400, parsed.error.issues[0]?.message ?? "名称无效");
  name = parsed.data;
  const piHome = resolvePiHome(options.piHome);
  if (hasEntry(profileLinkPath(piHome, name)))
    throw new Problem(409, "这个名称的配置入口还在");
  const cwd = desktopDirectory(desktops, name);
  mkdirSync(join(data, "credentials"), { recursive: true, mode: 0o700 });
  try {
    return store.transaction(() => {
      const { agent, token } = store.createAgent(name, cwd);
      const directory = prepareProfile(
        agent.id,
        resolveProfileTemplate(store, options),
        piHome,
      );
      try {
        linkProfile(piHome, name, directory);
        writeFileSync(
          join(data, "credentials", `${agent.id}.json`),
          JSON.stringify({ token }),
          { mode: 0o600, flag: "wx" },
        );
        store.run(
          "UPDATE agents SET agent_directory=?,description=? WHERE id=?",
          directory,
          options.description ?? "",
          agent.id,
        );
        return store.agent(agent.id);
      } catch (error) {
        unlinkProfile(piHome, name);
        rmSync(directory, { recursive: true, force: true });
        throw error;
      }
    });
  } catch (error) {
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      // Desktop rollback is best-effort; leftover dirs are refused on retry.
    }
    throw error;
  }
}
