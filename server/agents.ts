import { mkdirSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { defaultTemplate, prepareProfile } from "./profile.ts";
import { dirname, join, resolve, sep } from "node:path";
import { displayName } from "../shared/schema.ts";
import { Store, Problem } from "./store.ts";

/** Root of the fixed per-identity workspaces; each Agent gets ~/Atrium/<name>. */
export const defaultDesktops = () =>
  process.env.ATRIUM_DESKTOPS ?? join(homedir(), "Atrium");

/** Display form of the desktops root, collapsing the home directory to ~. */
export const displayDesktops = (root: string) => {
  const home = homedir();
  return root === home
    ? "~"
    : root.startsWith(home + sep)
      ? `~${root.slice(home.length)}`
      : root;
};

/** The desktop is created at identity creation and reused as cwd on every start. */
export function desktopDirectory(root: string, name: string) {
  const base = resolve(root);
  const target = resolve(base, name);
  if (name === "." || name === ".." || dirname(target) !== base)
    throw new Problem(400, "名称不能作为工作目录");
  try {
    mkdirSync(target, { recursive: true });
  } catch {
    throw new Problem(409, "无法创建工作目录，目标路径可能被文件占用");
  }
  return realpathSync(target);
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
        id: agent.ref,
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
  options: { template?: string; source?: string; description?: string } = {},
) {
  const parsed = displayName.safeParse(name);
  if (!parsed.success)
    throw new Problem(400, parsed.error.issues[0]?.message ?? "名称无效");
  name = parsed.data;
  const cwd = desktopDirectory(desktops, name);
  mkdirSync(join(data, "credentials"), { recursive: true, mode: 0o700 });
  return store.transaction(() => {
    const { agent, token } = store.createAgent(name, cwd);
    const directory = prepareProfile(
      data,
      agent.id,
      resolveProfileTemplate(store, options),
    );
    try {
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
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  });
}
