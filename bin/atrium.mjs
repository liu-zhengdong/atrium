#!/usr/bin/env node
import { register } from "tsx/esm/api";
import { existsSync } from "node:fs";
import { join } from "node:path";
register();
const [command, reference, ...extra] = process.argv.slice(2);
if (command === "--help" && !reference) {
  console.log(
    "atrium           — 启动或复用后台服务，打开 Web\natrium --no-open — 启动或复用服务，仅输出地址\natrium status    — 查看服务状态、地址和数据目录\natrium stop      — 停止服务及其托管的 Agent，保留数据\natrium run a1    — 用长期身份启动原生 Pi TUI\natrium list      — 查看身份短号\n\n关闭浏览器或终端不停止后台服务；stop 不终止外部 Pi TUI。\nATRIUM_DATA / PI_ACP_DIR 须与中庭服务一致。具名启动不接受任意 Pi 参数。",
  );
} else {
  try {
    const { dataDirectory, serviceUrl } =
      await import("../server/service-state.ts");
    const data = dataDirectory();
    if (
      (!command || ["--no-open", "status", "stop"].includes(command)) &&
      !reference
    ) {
      const { startService, serviceStatus, stopService, openWeb } =
        await import("../server/service.ts");
      if (command === "status") await serviceStatus(data);
      else if (command === "stop") await stopService(data);
      else {
        const record = await startService(data);
        console.log(
          `Atrium → ${serviceUrl(record)}\n服务已就绪 · PID ${record.pid}\n数据：${data}\n停止：atrium stop`,
        );
        if (command !== "--no-open") await openWeb(record);
      }
    } else {
      if (!(
        (command === "list" && !reference) ||
        (command === "run" && reference && !extra.length)
      ))
        throw new Error(
          "用法：atrium [--no-open|status|stop|list|run a1]；详见 atrium --help",
        );
      if (!existsSync(join(data, "atrium.sqlite")))
        throw new Error(
          "未找到中庭数据库；请先运行 atrium 打开 Web 并创建身份，或设置 ATRIUM_DATA",
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
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
