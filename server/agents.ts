import { mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Store, Problem } from "./store.ts";

/** Shared creation path for user-created and discovered identities. */
export function createAgent(
  store: Store,
  data: string,
  name: string,
  directory: string,
) {
  let cwd: string;
  try {
    cwd = realpathSync(resolve(directory));
    if (!statSync(cwd).isDirectory()) throw new Error();
  } catch {
    throw new Problem(400, "工作目录不存在或不可访问");
  }
  mkdirSync(join(data, "credentials"), { recursive: true, mode: 0o700 });
  return store.transaction(() => {
    const { agent, token } = store.createAgent(name, cwd);
    writeFileSync(
      join(data, "credentials", `${agent.id}.json`),
      JSON.stringify({ token }),
      { mode: 0o600, flag: "wx" },
    );
    return agent;
  });
}
