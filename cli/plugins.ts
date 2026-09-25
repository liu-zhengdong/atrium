import { findAgent, roster } from "./agents.ts";
import { connect } from "./service.ts";
import { printJson, table } from "./format.ts";
import type { Command } from "./main.ts";

type PluginList = {
  mode: "own";
  packages: {
    source: string;
    name: string;
    kind: string;
    version: string | null;
    enabled: boolean;
  }[];
};

const list: Command = {
  args: "名称",
  about: "列出此身份的插件",
  positionals: [1, 1],
  async run({ positionals: [reference], json }) {
    const client = await connect();
    const agent = findAgent(await roster(client), reference!);
    const result = await client.get<PluginList>(`/agents/${agent.id}/plugins`);
    if (json) return printJson(result);
    if (result.packages.length)
      console.log(
        table([
          ["名称", "来源", "版本", "状态"],
          ...result.packages.map((item) => [
            item.name,
            item.source,
            item.version ?? "",
            item.enabled ? "启用" : "停用",
          ]),
        ]),
      );
    else console.log("没有安装插件");
  },
};

const command = (
  action: "add" | "remove" | "update" | "enable" | "disable",
): Command => ({
  args: action === "update" ? "名称 [spec]" : "名称 spec",
  about: {
    add: "添加插件",
    remove: "移除插件",
    update: "更新单个插件；省略 spec 更新全部",
    enable: "启用插件",
    disable: "停用插件",
  }[action],
  positionals:
    action === "add" ||
    action === "remove" ||
    action === "enable" ||
    action === "disable"
      ? [2, 2]
      : [1, 2],
  async run({ positionals: [reference, spec], json }) {
    const client = await connect();
    const agent = findAgent(await roster(client), reference!);
    const result = await client.post<PluginList>(
      `/agents/${agent.id}/plugins`,
      { action: action === "update" && !spec ? "update-all" : action, spec },
    );
    if (json) return printJson(result);
    console.log(`${agent.name} · 插件操作已完成；运行中需重启后生效`);
  },
});

export const pluginCommands: Record<string, Command> = {
  plugins: list,
  "plugin add": command("add"),
  "plugin remove": command("remove"),
  "plugin update": command("update"),
  "plugin enable": command("enable"),
  "plugin disable": command("disable"),
};
