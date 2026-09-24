import { spawn } from "node:child_process";
import {
  autocomplete,
  autocompleteMultiselect,
  multiselect,
  cancel,
  log,
  outro,
  spinner,
  isCancel,
  password,
  select,
  text,
} from "@clack/prompts";
import type { Command } from "./main.ts";
import { connect } from "./service.ts";
import { roster } from "./agents.ts";
import type { ProviderEntry, ProviderMethod } from "../shared/providers.ts";
import {
  accountLabel,
  assignedAccountLabel,
  assignmentFailure,
  assignmentSummary,
  currentAssignment,
  defaultAccountName,
  methodsFor,
  skipMethod,
  skipProvider,
} from "../shared/providers.ts";

type LoginEvent = {
  type?: string;
  url?: string;
  userCode?: string;
  verificationUri?: string;
  message?: string;
  prompt?: { message: string; options?: { id: string; label: string }[] };
};
function input<T>(value: T): Exclude<T, symbol> {
  if (isCancel(value)) {
    cancel("已取消");
    throw new Cancelled();
  }
  return value as Exclude<T, symbol>;
}
class Cancelled extends Error {}
const encode = encodeURIComponent;

async function awaitLogin(
  client: Awaited<ReturnType<typeof connect>>,
  id: string,
) {
  let after = 0;
  let cancelled = false;
  const controller = new AbortController();
  const interrupt = () => {
    cancelled = true;
    controller.abort();
    void client.post(`/accounts/${id}/login/cancel`).catch(() => {});
  };
  process.on("SIGINT", interrupt);
  try {
    while (!cancelled) {
      const result = await client.get<{
        events: LoginEvent[];
        next: number;
        done: boolean;
        status: string;
      }>(`/accounts/${id}/login?after=${after}`);
      after = result.next;
      for (const event of result.events) {
        if (cancelled) break;
        if (event.type === "auth_url" && event.url) {
          log.info(`登录链接：${event.url}`);
          if (process.platform === "darwin")
            spawn("open", [event.url], { stdio: "ignore" }).unref();
          else if (process.platform === "win32")
            spawn("cmd", ["/c", "start", "", event.url], {
              stdio: "ignore",
            }).unref();
          else
            spawn("xdg-open", [event.url], { stdio: "ignore" }).on(
              "error",
              () => {},
            );
        }
        if (event.type === "device_code")
          log.info(
            `设备码：${event.userCode}\n验证地址：${event.verificationUri}`,
          );
        if (event.type === "info" && event.message) log.info(event.message);
        if (event.prompt) {
          const { options, message } = event.prompt;
          const value = options
            ? input(
                await select({
                  message,
                  signal: controller.signal,
                  options: options.map((item) => ({
                    value: item.id,
                    label: item.label,
                  })),
                }),
              )
            : input(await text({ message, signal: controller.signal }));
          await client.post(`/accounts/${id}/login/answer`, { value });
        }
      }
      if (result.done) {
        if (result.status !== "ready") throw new Error("登录未完成");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Cancelled();
  } finally {
    process.off("SIGINT", interrupt);
    if (cancelled)
      await client.post(`/accounts/${id}/login/cancel`).catch(() => {});
  }
}

export const connectCommand: Command = {
  args: "[provider]",
  about: "交互连接供应商账号并可分配给 Agent",
  positionals: [0, 1],
  async run({ positionals: [reference] }) {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      throw new Error(
        "connect 需要交互终端；脚本请使用 atrium account add <provider> --key -",
      );
    const client = await connect();
    const reading = spinner();
    reading.start("正在读取供应商…");
    let providers: ProviderEntry[];
    try {
      providers = await client.get<ProviderEntry[]>("/providers");
      reading.stop();
    } catch (error) {
      reading.error("供应商目录读取失败");
      throw error;
    }
    const existing = await client.get<
      {
        id: string;
        name: string;
        provider: string;
        assigned: string[];
        status: string;
      }[]
    >("/accounts");
    const fixed = reference
      ? providers.find((item) =>
          [item.id, item.name].some(
            (value) => value.toLowerCase() === reference.toLowerCase(),
          ),
        )
      : undefined;
    if (reference && !fixed)
      log.warn(`未找到「${reference}」，请从列表选择供应商`);
    let id: string | undefined;
    try {
      let method: ProviderMethod;
      if (skipMethod(fixed)) method = fixed!.methods[0]!;
      else
        method = input(
          await select<ProviderMethod>({
            message: "连接方式",
            options: [
              {
                value: "oauth",
                label: "账号登录",
                hint: "用已有订阅在浏览器登录，如 ChatGPT、Claude、Copilot",
              },
              {
                value: "api_key",
                label: "API Key",
                hint: "粘贴供应商后台生成的密钥",
              },
            ],
          }),
        );
      const candidates = providers.filter(
        (entry) => methodsFor(entry, method).length,
      );
      if (!candidates.length) throw new Error("此方式没有可连接的供应商");
      const chosen = skipProvider(fixed)
        ? fixed!.id
        : input(
            await autocomplete({
              message: "供应商（输入筛选）",
              maxItems: 10,
              initialUserInput: reference && !fixed ? reference : undefined,
              filter: (query, option) =>
                `${option.label} ${option.value}`
                  .toLowerCase()
                  .includes(query.toLowerCase()),
              options: candidates.map((entry) => ({
                value: entry.id,
                label: `${entry.name}${existing.some((account) => account.provider === entry.id) ? " · 已有账号" : ""}`,
                hint: entry.id,
              })),
            }),
          );
      const provider = candidates.find((entry) => entry.id === chosen);
      if (!provider || !methodsFor(provider, method).length)
        throw new Error(`供应商不支持此方式：${chosen}`);
      const key =
        method === "api_key"
          ? input(
              await password({
                message: "API Key",
                validate: (value) => (value?.trim() ? undefined : "不能为空"),
              }),
            )
          : undefined;
      const name = input(
        await text({
          message: "账号名",
          initialValue: defaultAccountName(provider, existing),
          validate: (value) => (value?.trim() ? undefined : "不能为空"),
        }),
      ).trim();
      if (method === "api_key") {
        id = (
          await client.post<{ id: string }>("/accounts", {
            provider: provider.id,
            name,
            key: key!.trim(),
          })
        ).id;
      } else {
        id = (
          await client.post<{ id: string }>("/accounts/login", {
            provider: provider.id,
            name,
          })
        ).id;
        await awaitLogin(client, id);
      }
      const saved = `${accountLabel(provider, name, id)}${method === "api_key" ? "已保存" : "已连接"}`;
      log.success(saved);
      const agents = (await roster(client)).agents;
      const options = agents.map((agent) => ({
        value: agent.id,
        label: `${agent.name} (${agent.ref})${assignedAccountLabel(agent.ref, provider.id, existing) ? ` · 当前 ${assignedAccountLabel(agent.ref, provider.id, existing)}` : ""}`,
      }));
      const selected = !agents.length
        ? []
        : input(
            await (agents.length > 8
              ? autocompleteMultiselect({
                  message: "给哪些 Agent 用？（可留空跳过）",
                  required: false,
                  maxItems: 8,
                  filter: (query, option) =>
                    `${option.label}`
                      .toLowerCase()
                      .includes(query.toLowerCase()),
                  options,
                })
              : multiselect({
                  message: "给哪些 Agent 用？（可留空跳过）",
                  required: false,
                  options,
                })),
          );
      const added: string[] = [];
      const replaced: string[] = [];
      const failures: string[] = [];
      for (const agentId of selected) {
        const agent = agents.find((item) => item.id === agentId)!;
        const previous = currentAssignment(agent.ref, provider.id, existing);
        try {
          await client.post(`/assign/${encode(agentId)}`, {
            account: id,
            ...(previous ? { replace: true } : {}),
          });
          if (previous)
            replaced.push(
              `${agent.name}（${agent.ref}）：${assignedAccountLabel(agent.ref, provider.id, existing)} → ${name}（${id}）`,
            );
          else added.push(`${agent.name}（${agent.ref}）`);
        } catch (error) {
          failures.push(assignmentFailure(agent, error, provider, existing));
        }
      }
      const summary = assignmentSummary(added, replaced, failures);
      outro(
        summary
          ? `${saved}；${summary.replaceAll("\n", "；")}`
          : `${saved}，未分配；稍后用 atrium assign <身份> ${id}`,
      );
      if (failures.length) return 1;
    } catch (error) {
      if (
        id &&
        (error instanceof Cancelled ||
          (error instanceof Error && error.name === "AbortError"))
      )
        await client.post(`/accounts/${id}/login/cancel`).catch(() => {});
      if (
        error instanceof Cancelled ||
        (error instanceof Error && error.name === "AbortError")
      )
        return 0;
      throw error;
    }
  },
};
