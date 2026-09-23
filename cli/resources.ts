import { readFileSync } from "node:fs";
import { findAgent, roster } from "./agents.ts";
import { connect } from "./service.ts";
import { printJson, table } from "./format.ts";
import { str, type Command } from "./main.ts";

const target = async (reference: string) => {
  const client = await connect();
  const agent = findAgent(await roster(client), reference);
  return { client, path: `/agents/${agent.id}` };
};
const textFrom = (source: string) =>
  source === "-" ? readFileSync(0, "utf8") : readFileSync(source, "utf8");
type Skill = {
  key: string;
  name: string;
  description: string;
  enabled: boolean;
};
type Mcp = {
  text: string;
  builtin: string;
  servers: { name: string; address: string }[];
};
type Rule = { name: string; text: string };
const skills: Command = {
  args: "名称",
  about: "列出身份技能与启用状态",
  positionals: [1, 1],
  async run({ positionals: [ref], json }) {
    const { client, path } = await target(ref!);
    const result = await client.get<Skill[]>(`${path}/skills`);
    if (json) return printJson(result);
    console.log(
      result.length
        ? table([
            ["技能", "状态", "描述"],
            ...result.map((item) => [
              item.name,
              item.enabled ? "启用" : "停用",
              item.description,
            ]),
          ])
        : "没有技能",
    );
  },
};
const skill = (action: "enable" | "disable" | "remove" | "copy"): Command => ({
  args: "名称 技能",
  about: `${{ enable: "启用", disable: "停用", remove: "删除（服务端保留备份）", copy: "从个人 Pi 模板复制" }[action]}技能`,
  positionals: [2, 2],
  async run({ positionals: [ref, name], json }) {
    const { client, path } = await target(ref!);
    const result = await client.post<Skill[]>(`${path}/skills`, {
      action,
      name,
    });
    if (json) return printJson(result);
    console.log(
      `已${{ enable: "启用", disable: "停用", remove: "删除", copy: "复制" }[action]} ${name}；运行中的 Agent 重启后生效`,
    );
  },
});
const mcp: Command = {
  args: "名称 [--edit 文件|-]",
  about: "列出 MCP 服务；--edit 从文件或标准输入保存完整 JSON",
  options: { edit: { type: "string" } },
  positionals: [1, 1],
  async run({ positionals: [ref], values, json }) {
    const { client, path } = await target(ref!);
    const edit = str(values, "edit");
    const result =
      edit === undefined
        ? await client.get<Mcp>(`${path}/mcp`)
        : await client.put<Mcp>(`${path}/mcp`, { text: textFrom(edit) });
    if (json) return printJson(result);
    console.log(
      table([
        ["服务", "命令或 URL"],
        [result.builtin, "内置"],
        ...result.servers.map((item) => [item.name, item.address]),
      ]),
    );
    if (edit !== undefined) console.log("已保存；运行中的 Agent 重启后生效");
  },
};
const rules: Command = {
  args: "名称 [--file AGENTS.md|SYSTEM.md|APPEND_SYSTEM.md] [--set 文件|-]",
  about: "查看或保存身份规则文件",
  options: { file: { type: "string" }, set: { type: "string" } },
  positionals: [1, 1],
  async run({ positionals: [ref], values, json }) {
    const { client, path } = await target(ref!);
    const name = str(values, "file") ?? "AGENTS.md";
    if (!["AGENTS.md", "SYSTEM.md", "APPEND_SYSTEM.md"].includes(name))
      throw new Error("规则文件名无效");
    const input = str(values, "set");
    const result =
      input === undefined
        ? await client.get<Rule[]>(`${path}/rules`)
        : await client.put<Rule[]>(`${path}/rules`, {
            name,
            text: textFrom(input),
          });
    if (json) return printJson(result);
    const item = result.find((rule) => rule.name === name);
    if (!item) throw new Error("规则文件不存在");
    console.log(item.text);
    if (input !== undefined) console.log("已保存；运行中的 Agent 重启后生效");
  },
};
export const resourceCommands: Record<string, Command> = {
  skills,
  "skill enable": skill("enable"),
  "skill disable": skill("disable"),
  "skill remove": skill("remove"),
  "skill copy": skill("copy"),
  mcp,
  rules,
};
