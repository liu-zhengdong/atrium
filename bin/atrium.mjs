#!/usr/bin/env node
import { register } from "tsx/esm/api";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
register();
const [command, reference, ...extra] = process.argv.slice(2);
const usage =
  "用法：atrium [--no-open|status|stop|list|create 名称 [--from 名称]|run 名称|model 名称 [模型]]；详见 atrium --help";
if (command === "--help" && !reference) {
  console.log(
    "atrium           — 启动或复用后台服务，打开 Web\natrium --no-open — 启动或复用服务，仅输出地址\natrium status    — 查看服务状态、地址和数据目录\natrium stop      — 停止服务及其托管的 Agent，保留数据\natrium create 名称 — 从内置类型创建长期身份，不启动进程\natrium create 名称 --from 名称 — 从已有身份 fork\natrium run 名称  — 用长期身份启动原生 Pi TUI\natrium list      — 查看身份\natrium model 名称 — 查看这个身份的模型和可选项\natrium model 名称 provider/id[:思考强度] — 设定模型；在跑的身份当场生效\n\n关闭浏览器或终端不停止后台服务；stop 不终止外部 Pi TUI。\nATRIUM_DATA / PI_ACP_DIR 须与中庭服务一致。具名启动不接受任意 Pi 参数。",
  );
} else {
  try {
    const { alive, dataDirectory, readService, serviceUrl } =
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
    } else if (command === "model") {
      if (!reference || extra.length > 1) throw new Error(usage);
      const { modelCommand } = await import("../server/model.ts");
      await modelCommand(data, reference, extra[0]);
    } else if (command === "create") {
      if (!reference) throw new Error(usage);
      let source = "builtin";
      if (extra[0] === "--from") {
        if (!extra[1] || extra.length !== 2) throw new Error(usage);
        source = extra[1];
      } else if (extra.length) throw new Error(usage);
      const record = readService(data);
      const report = (agent) => {
        console.log(agent.name);
      };
      if (record && alive(record.pid)) {
        const response = await fetch(`${serviceUrl(record)}/api/agents`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: reference, source, start: false }),
        });
        const body = await response.json();
        if (!response.ok)
          throw new Error(
            typeof body.error === "string" ? body.error : "创建失败",
          );
        report(body.agent);
      } else {
        mkdirSync(data, { recursive: true, mode: 0o700 });
        const { Store } = await import("../server/store.ts");
        const { createAgent, defaultDesktops } =
          await import("../server/agents.ts");
        const store = new Store(join(data, "atrium.sqlite"));
        try {
          report(
            createAgent(store, data, reference, defaultDesktops(), { source }),
          );
        } finally {
          store.close();
        }
      }
    } else {
      if (!(
        (command === "list" && !reference) ||
        (command === "run" && reference && !extra.length)
      ))
        throw new Error(usage);
      if (!existsSync(join(data, "atrium.sqlite")))
        throw new Error(
          "未找到中庭数据库；请先运行 atrium create 或打开 Web 创建身份，或设置 ATRIUM_DATA",
        );
      const { Store } = await import("../server/store.ts");
      const store = new Store(join(data, "atrium.sqlite"));
      let agent;
      try {
        if (command === "list" && !reference) {
          for (const a of store.agents())
            console.log(
              `${a.name}\t${a.agent_directory ? "长期身份" : "旧记录（待升级）"}`,
            );
        } else if (command === "run" && reference && !extra.length) {
          agent = store.agent(store.resolveAgentId(reference));
          if (!agent.agent_directory)
            throw new Error(
              "旧记录尚未升级；请在中庭运行设置中显式升级，历史会保留",
            );
        } else throw new Error(usage);
      } finally {
        store.db.close();
      }
      if (agent) {
        const { runNamedTui } =
          await import("@liuser/pi-atrium/dist/identity.js");
        const { readIdentityModel, syncIdentityProfile } =
          await import("../server/profile.ts");
        const { formatModelSpec } = await import("../shared/model.ts");
        // Same catch-up the service does on start, so both entries agree.
        for (const notice of syncIdentityProfile(agent.agent_directory))
          console.error(`${agent.name} 的${notice}`);
        console.error(`中庭 · ${agent.name}\n${agent.cwd}`);
        const launchStore = new Store(join(data, "atrium.sqlite"));
        let running;
        try {
          running = launchStore.transaction(() => {
            const current = launchStore.agent(agent.id);
            // 恢复的会话自带模型记录，会盖过配置默认值；只有启动参数压得住它。
            const model = readIdentityModel(current.agent_directory);
            return runNamedTui({
              identityId: current.id,
              agentDirectory: current.agent_directory,
              cwd: current.cwd,
              ...(current.session_file
                ? { sessionFile: current.session_file }
                : {}),
              ...(model ? { model: formatModelSpec(model) } : {}),
            });
          });
        } finally {
          launchStore.close();
        }
        process.exitCode = await running;
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
