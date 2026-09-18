import {
  mkdirSync,
  realpathSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { prepareProfile } from "./profile.ts";
import { dirname, join, resolve } from "node:path";
import { Store, Problem } from "./store.ts";

/** Root of the fixed per-identity workspaces; each Agent gets ~/Atrium/<name>. */
export const defaultDesktops = () =>
  process.env.ATRIUM_DESKTOPS ?? join(homedir(), "Atrium");

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

/** User-facing creation: assigns the identity's fixed desktop workspace. */
export function createAgent(
  store: Store,
  data: string,
  name: string,
  desktops: string,
  options: { template?: string; description?: string } = {},
) {
  const cwd = desktopDirectory(desktops, name);
  mkdirSync(join(data, "credentials"), { recursive: true, mode: 0o700 });
  return store.transaction(() => {
    const { agent, token } = store.createAgent(name, cwd);
    const directory = prepareProfile(data, agent.id, options.template);
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
