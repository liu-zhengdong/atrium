import { stdin } from "node:process";
import { connect } from "./service.ts";
import { printJson, table } from "./format.ts";
import { str, type Command, type Values } from "./main.ts";

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
                a.type,
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
    args: "provider [--name 名称] --key -",
    about: "从标准输入读取 API key 加入账号库",
    positionals: [1, 1],
    options: { ...nameOption, key: { type: "string" } },
    async run({ positionals: [provider], values }) {
      if (str(values, "key") !== "-")
        throw new Error("只接受 --key - 从标准输入读取");
      let key = "";
      for await (const chunk of stdin) key += chunk.toString();
      const result = await (
        await connect()
      ).post<{ id: string }>("/accounts", {
        provider,
        name: name(provider!, values),
        key: key.trimEnd(),
      });
      console.log(`账号 ${result.id} 已添加`);
    },
  },
  "account login": {
    args: "provider [--name 名称]",
    about: "终端完成 OAuth 登录",
    positionals: [1, 1],
    options: nameOption,
    async run({ positionals: [provider], values }) {
      const client = await connect();
      const { id } = await client.post<{ id: string }>("/accounts/login", {
        provider,
        name: name(provider!, values),
      });
      console.log(`账号 ${id} 正在登录`);
      let after = 0;
      let cancelled = false;
      let cancelPrompt: (() => void) | undefined;
      const onInterrupt = () => {
        cancelled = true;
        cancelPrompt?.();
        void client.post(`/accounts/${id}/login/cancel`).catch(() => {});
      };
      process.once("SIGINT", onInterrupt);
      try {
        while (true) {
          if (cancelled) {
            console.log("登录已取消");
            return;
          }
          const result = await client.get<{
            events: {
              type?: string;
              url?: string;
              userCode?: string;
              verificationUri?: string;
              message?: string;
              prompt?: {
                type: string;
                message: string;
                options?: { id: string; label: string }[];
              };
            }[];
            next: number;
            done: boolean;
            status: string;
          }>(`/accounts/${id}/login?after=${after}`);
          after = result.next;
          for (const event of result.events) {
            if (event.type === "auth_url")
              console.log(`登录链接：${event.url}`);
            if (event.type === "device_code")
              console.log(
                `设备码：${event.userCode}\n验证地址：${event.verificationUri}`,
              );
            if (event.type === "info") console.log(event.message);
            if (event.prompt) {
              const prompt = event.prompt;
              if (prompt.options)
                for (const choice of prompt.options)
                  console.log(`${choice.id}  ${choice.label}`);
              process.stdout.write(`${prompt.message} `);
              const value = await new Promise<string | null>((resolve) => {
                let buffer = "";
                const finish = (value: string | null) => {
                  stdin.off("data", receive);
                  stdin.off("end", ended);
                  stdin.pause();
                  cancelPrompt = undefined;
                  resolve(value);
                };
                const receive = (chunk: Buffer) => {
                  buffer += chunk.toString();
                  if (buffer.includes("\n")) finish(buffer.trim());
                };
                const ended = () => finish(null);
                cancelPrompt = () => finish(null);
                stdin.on("data", receive);
                stdin.once("end", ended);
                stdin.resume();
              });
              if (cancelled) {
                console.log("登录已取消");
                return;
              }
              await client.post(`/accounts/${id}/login/answer`, { value });
            }
          }
          if (result.done) {
            if (result.status !== "ready") throw new Error("登录未完成");
            console.log(`账号 ${id} 已登录`);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      } finally {
        process.off("SIGINT", onInterrupt);
      }
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
      ).post<{ mode: string; preserved: string | null }>(
        `/assign/${encode(agent!)}`,
        { account },
      );
      console.log(
        `已分配；模式：${result.mode}${result.preserved ? `；原文件已保留：${result.preserved}` : ""}`,
      );
    },
  },
  unassign: {
    args: "身份 provider",
    about: "撤销指定 provider 的分配",
    positionals: [2, 2],
    async run({ positionals: [agent, provider] }) {
      await (
        await connect()
      ).delete(`/assign/${encode(agent!)}/${encode(provider!)}`);
      console.log("已撤销分配");
    },
  },
  credentials: {
    args: "身份 [shared|assigned]",
    about: "查看或切换身份凭据模式",
    positionals: [1, 2],
    async run({ positionals: [agent, mode], json }) {
      const client = await connect();
      const result = mode
        ? await client.put<{ mode: string; preserved: string | null }>(
            `/credentials/${encode(agent!)}`,
            { mode },
          )
        : await client.get<{ mode: string; assigned: unknown[] }>(
            `/credentials/${encode(agent!)}`,
          );
      if (json) return printJson(result);
      console.log(
        `模式：${result.mode}${"preserved" in result && result.preserved ? `；原文件已保留：${result.preserved}` : ""}`,
      );
    },
  },
};
