#!/usr/bin/env node
import { register } from "tsx/esm/api";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
register();
const [command, reference, ...extra] = process.argv.slice(2);
if (command === "--help" || !command) {
  console.log(
    "atrium run a1  — 用长期身份启动原生 Pi TUI\natrium list    — 查看身份短号\nATRIUM_DATA / PI_ACP_DIR 须与中庭服务一致。具名启动不接受任意 Pi 参数。",
  );
} else {
  try {
    const data = resolve(
      process.env.ATRIUM_DATA ??
        fileURLToPath(new URL("../.atrium", import.meta.url)),
    );
    if (!existsSync(join(data, "atrium.sqlite")))
      throw new Error(
        "未找到中庭数据库；请先在 UI 创建身份，或设置 ATRIUM_DATA",
      );
    const { Store } = await import("../server/store.ts");
    const store = new Store(join(data, "atrium.sqlite"));
    let agent;
    try {
      if (command === "list" && !reference) {
        for (const a of store.agents())
          console.log(
            `${a.ref}\t${a.name}\t${a.agent_directory ? "长期身份" : "旧记录（待升级）"}`,
          );
      } else if (command === "run" && reference && !extra.length) {
        agent = store.agent(store.resolveAgentId(reference));
        if (!agent.agent_directory)
          throw new Error(
            "旧记录尚未升级；请在中庭运行设置中显式升级，历史会保留",
          );
      } else throw new Error("用法：atrium run a1 | atrium list");
    } finally {
      store.db.close();
    }
    if (agent) {
      const { runNamedTui } = await import("@liuser/pi-acp/dist/identity.js");
      console.error(`中庭 · ${agent.name} (${agent.ref})\n${agent.cwd}`);
      process.exitCode = await runNamedTui({
        identityId: agent.id,
        agentDirectory: agent.agent_directory,
        cwd: agent.cwd,
        ...(agent.session_file ? { sessionFile: agent.session_file } : {}),
      });
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
