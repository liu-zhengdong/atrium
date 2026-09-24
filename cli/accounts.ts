import { stdin } from "node:process";
import { recordNext } from "./contract.ts";
import { connect } from "./service.ts";
import { printJson, table } from "./format.ts";
import { str, type Command, type Values } from "./main.ts";
import { Problem } from "../server/problem.ts";

type Account = {
  id: string;
  provider: string;
  name: string;
  type: string;
  expires: number | null;
  status: string;
  last_error: string | null;
  assigned: string[];
};
const nameOption = { name: { type: "string" as const } };
const name = (provider: string, values: Values) =>
  str(values, "name") ?? provider;
const encode = encodeURIComponent;
export const accountCommands: Record<string, Command> = {
  "account check": {
    args: "[账号]",
    about: "检查账号或列出未分配的身份；有未分配时退出码 4",
    positionals: [0, 1],
    async run({ json, positionals: [ref] }) {
      const service = await connect();
      if (ref) {
        const result = await service.post<{
          status: string;
          reason: string | null;
        }>(`/accounts/${encode(ref)}/check`, {});
        if (json) return printJson(result);
        if (result.reason)
          throw new Problem(
            409,
            result.reason,
            "validation_failed",
            undefined,
            result.reason.includes("Claude CLI")
              ? "claude --version"
              : undefined,
          );
        console.log(`${ref} Claude CLI 可用（未验证登录）`);
        return;
      }
      const localIssues: string[] = [];
      for (const account of await service.get<Account[]>("/accounts"))
        if (account.type === "local") {
          const checked = await service.post<{ reason: string | null }>(
            `/accounts/${encode(account.id)}/check`,
            {},
          );
          if (checked.reason)
            localIssues.push(`  ${account.id}：${checked.reason}`);
        }
      const result = await service.get<{
        unassigned: {
          ref: string;
          name: string;
          command: string;
          matched: boolean;
        }[];
        accounts: {
          id: string;
          provider: string;
          name: string;
          status: string;
        }[];
      }>("/assignment-check");
      if (result.unassigned.length) {
        const lines = [
          ...localIssues,
          `有 ${result.unassigned.length} 个身份未分配账号：`,
          ...result.unassigned.map(
            (agent) => `  ${agent.ref} ${agent.name}：${agent.command}`,
          ),
        ];
        if (result.unassigned.some((agent) => !agent.matched))
          lines.push(
            "可用账号：",
            ...(result.accounts.length
              ? result.accounts.map(
                  (account) =>
                    `  ${account.id} ${account.name} (${account.provider}，${account.status})`,
                )
              : ["  暂无"]),
            "添加账号：atrium connect",
          );
        throw new Problem(409, lines.join("\n"), "validation_failed");
      }
      if (localIssues.length)
        throw new Problem(409, localIssues.join("\n"), "validation_failed");
      if (json) return printJson(result);
      console.log("所有身份均已分配账号");
    },
  },
  accounts: {
    args: "",
    about: "列出账号及分配（不显示密钥）",
    positionals: [0, 0],
    async run({ json }) {
      const list = await (await connect()).get<Account[]>("/accounts");
      if (json) return printJson(list);
      console.log(
        list.length
          ? table([
              ["短号", "Provider", "名称", "类型", "状态", "到期", "分配"],
              ...list.map((a) => [
                a.id,
                a.provider,
                a.name,
                a.type === "local" ? "本机登录 · 不保存 Key" : a.type,
                a.status,
                a.expires ? new Date(a.expires).toLocaleString() : "",
                a.assigned.join(","),
              ]),
            ])
          : "暂无账号",
      );
    },
  },
  "account add": {
    args: "provider [--local | --name 名称 --key -]",
    about: "添加 API Key 或本机 Claude CLI 登录",
    positionals: [1, 1],
    options: {
      ...nameOption,
      key: { type: "string" },
      local: { type: "boolean" },
    },
    async run({ positionals: [provider], values }) {
      if (values.local) {
        if (str(values, "key") || str(values, "name"))
          throw new Problem(400, "本机登录不需要 --key 或 --name");
        const result = await (
          await connect()
        ).post<{ id: string }>("/accounts/local", { provider });
        console.log(
          `本机登录账号 ${result.id} 已添加；下一步：atrium assign <身份> ${result.id}`,
        );
        return;
      }
      if (str(values, "key") !== "-")
        throw new Problem(400, "只接受 --key - 从标准输入读取");
      let key = "";
      for await (const chunk of stdin) key += chunk.toString();
      const result = await (
        await connect()
      ).post<{ id: string | null; validation: { reason?: string } }>(
        "/accounts",
        {
          provider,
          name: name(provider!, values),
          key: key.trimEnd(),
        },
      );
      if (!result.id)
        throw new Error(
          `未保存：${result.validation.reason ?? "未能校验"}；可在 atrium connect 中选择仍然保存`,
        );
      console.log(`账号 ${result.id} 已添加`);
    },
  },
  "account rename": {
    args: "账号 名称",
    about: "修改账号显示名",
    positionals: [2, 2],
    async run({ positionals: [ref, name] }) {
      await (await connect()).patch(`/accounts/${encode(ref!)}`, { name });
      console.log("已改名");
    },
  },
  "account remove": {
    args: "账号",
    about: "撤销所有分配并删除账号",
    positionals: [1, 1],
    async run({ positionals: [ref] }) {
      await (await connect()).delete(`/accounts/${encode(ref!)}`);
      console.log("账号已删除");
    },
  },
  assign: {
    args: "身份 账号",
    about: "把账号分配给身份（首次分配切为独立凭据）",
    positionals: [2, 2],
    async run({ positionals: [agent, account] }) {
      const result = await (
        await connect()
      ).post<{
        account: string;
        agentName: string;
        accountName?: string;
        preserved: string | null;
      }>(`/assign/${encode(agent!)}`, { account });
      console.log(
        `已分配：${result.agentName} → ${result.account}${result.accountName ? ` ${result.accountName}` : ""}${result.preserved ? `；原文件已保留：${result.preserved}` : ""}`,
      );
    },
  },
  unassign: {
    args: "身份 provider",
    about: "撤销指定 provider 的分配",
    positionals: [2, 2],
    async run({ positionals: [agent, provider], json }) {
      const result = await (
        await connect()
      ).delete<{
        name: string;
        stopped: boolean;
        hasAssignment: boolean;
        nextCommand: string | null;
      }>(`/assign/${encode(agent!)}/${encode(provider!)}`);
      if (result.nextCommand) recordNext(`重新分配：${result.nextCommand}`);
      if (json) return printJson(result);
      console.log("已撤销分配");
      if (result.stopped)
        console.log(`${result.name} 已停止：没有分配账号就不能运行`);
    },
  },
};
