import { spawn } from "node:child_process";
import {
  autocomplete,
  autocompleteMultiselect,
  multiselect,
  cancel,
  log,
  outro,
  isCancel,
  password,
  select,
  text,
} from "@clack/prompts";
import type { Command } from "./main.ts";
import { str, strs } from "./main.ts";
import { connect } from "./service.ts";
import { Problem } from "../server/problem.ts";
import { recordNext, recordResult } from "./contract.ts";
import { roster } from "./agents.ts";
import type { ProviderEntry, ProviderMethod } from "../shared/providers.ts";
import {
  accountLabel,
  assignedAccountLabel,
  assignmentFailure,
  assignmentSummary,
  CLAUDE_CLOSED,
  currentAssignment,
  defaultAccountName,
  methodsFor,
  retiredProvider,
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

// Keep slow work visible without leaving Clack's empty completion row.
async function withProgress<T>(
  label: string,
  work: () => Promise<T>,
): Promise<T> {
  if (!process.stdout.isTTY) return work();
  let ticks = 0;
  const timer = setInterval(() => {
    process.stdout.write(`\r${label}${".".repeat((ticks++ % 3) + 1)}   `);
  }, 300);
  try {
    return await work();
  } finally {
    clearInterval(timer);
    if (ticks) process.stdout.write("\r\x1b[2K");
  }
}

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
  args: "[provider] [--custom provider-id --base-url URL --api-key KEY --model ID …]",
  options: {
    custom: { type: "string" },
    "base-url": { type: "string" },
    "api-key": { type: "string" },
    model: { type: "string", multiple: true },
  },
  about: "交互连接供应商账号并可分配给 Agent",
  positionals: [0, 1],
  async run({ positionals: [reference], values, json }) {
    if (str(values, "custom")) {
      const provider = str(values, "custom")!;
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(provider))
        throw new Problem(
          400,
          "--custom 要填 provider id：小写字母开头，只能用小写字母、数字和连字符，最多 64 字符",
          "usage",
        );
      const client = await connect(true);
      const baseUrl =
        str(values, "base-url") ??
        (process.stdin.isTTY ? input(await text({ message: "Base URL" })) : "");
      const key =
        str(values, "api-key") ??
        (process.stdin.isTTY
          ? input(await password({ message: "API Key（本地可留空）" }))
          : "");
      let models = strs(values, "model");
      let offered: string[] = [];
      if (!models.length && baseUrl) {
        try {
          offered = (
            await client.post<{ models: string[] }>("/custom/models", {
              config: { baseUrl, models: [{ id: "placeholder" }] },
              key,
            })
          ).models;
        } catch (error) {
          if (process.stdin.isTTY)
            log.warn(`模型列表不可用：${String(error)}；请手填模型`);
        }
        if (process.stdin.isTTY && offered.length)
          models = input(
            await autocompleteMultiselect({
              message: "模型（可多选）",
              options: offered.map((id) => ({ value: id, label: id })),
            }),
          );
      }
      if (!models.length && process.stdin.isTTY)
        models = [input(await text({ message: "模型 ID" }))];
      if (!baseUrl || !models.length)
        throw new Problem(
          400,
          offered.length && baseUrl
            ? `这个服务提供：${offered.join("、")}；用 --model 选择`
            : "需要 --base-url 和至少一个 --model",
          "usage",
        );
      const saved = await client.post<{ id: string }>("/accounts", {
        provider,
        name: provider,
        key,
        custom: { baseUrl, models: models.map((id) => ({ id })) },
      });
      recordResult({ ...saved, provider });
      recordNext(`分配：atrium assign 名称 ${saved.id}`);
      if (!json)
        if (process.stdout.isTTY)
          log.success(`${provider}（${saved.id}）已保存`);
        else console.log(`${provider}（${saved.id}）已保存`);
      return 0;
    }
    if (reference === "claude-bridge")
      throw new Problem(400, CLAUDE_CLOSED, "provider_retired");
    const retired = reference ? retiredProvider(reference) : undefined;
    if (retired)
      throw new Problem(
        400,
        retired.reason,
        "provider_retired",
        undefined,
        retired.fix,
      );
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      throw new Error(
        "connect 需要交互终端；脚本请使用 atrium account add <provider> --key -",
      );
    const { client, providers, existing } = await withProgress(
      "正在读取供应商",
      async () => {
        const client = await connect(true);
        const providers = await client.get<ProviderEntry[]>("/providers");
        const existing = await client.get<
          {
            id: string;
            name: string;
            provider: string;
            assigned: string[];
            status: string;
          }[]
        >("/accounts");
        return { client, providers, existing };
      },
    );
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
                hint: "用已有订阅在浏览器登录，如 ChatGPT、SuperGrok",
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
      let key: string | undefined;
      let validation: { status: string; reason?: string } | undefined;
      if (method === "api_key") {
        for (;;) {
          key = input(
            await password({
              message: "API Key",
              validate: (value) => (value?.trim() ? undefined : "不能为空"),
            }),
          ).trim();
          try {
            validation = await withProgress("正在校验 API Key", () =>
              client.post("/accounts/validate", {
                provider: provider.id,
                key,
              }),
            );
            break;
          } catch (error) {
            if (
              !(error instanceof Problem) ||
              error.code !== "validation_failed"
            )
              throw error;
            log.warn(error.message);
          }
        }
      }
      const name = input(
        await text({
          message: "账号名",
          initialValue: defaultAccountName(provider, existing),
          validate: (value) => (value?.trim() ? undefined : "不能为空"),
        }),
      ).trim();
      if (method === "api_key") {
        const payload = { provider: provider.id, name, key };
        let allowUnverified = false;
        if (validation?.status === "unverified") {
          allowUnverified = input(
            await select({
              message: `${validation.reason ?? "没能校验"}；仍然保存为未校验？`,
              options: [
                { value: true, label: "仍然保存" },
                { value: false, label: "返回" },
              ],
            }),
          );
          if (!allowUnverified) return 0;
        }
        const saved = await client.post<{
          id: string | null;
          validation: { status: string; reason?: string };
        }>("/accounts", { ...payload, allowUnverified });
        if (!saved.id) {
          const proceed = input(
            await select({
              message: `${saved.validation.reason ?? "没能校验"}；仍然保存为未校验？`,
              options: [
                { value: true, label: "仍然保存" },
                { value: false, label: "返回" },
              ],
            }),
          );
          if (!proceed) return 0;
          const retried = await client.post<{ id: string }>("/accounts", {
            ...payload,
            allowUnverified: true,
          });
          id = retried.id;
        } else id = saved.id;
        if (saved.validation.status !== "verified")
          log.warn(`账号未校验：${saved.validation.reason ?? "需要额外配置"}`);
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
      const assignNow = agents.length
        ? input(
            await select({
              message: "现在分配给 Agent 吗？",
              options: [
                { value: false, label: "不分配" },
                { value: true, label: "选择 Agent" },
              ],
            }),
          )
        : false;
      const selected = !assignNow
        ? []
        : input(
            await (agents.length > 8
              ? autocompleteMultiselect({
                  message: "给哪些 Agent 用？",
                  required: true,
                  maxItems: 8,
                  filter: (query, option) =>
                    `${option.label}`
                      .toLowerCase()
                      .includes(query.toLowerCase()),
                  options,
                })
              : multiselect({
                  message: "给哪些 Agent 用？",
                  required: true,
                  options,
                })),
          );
      const added: string[] = [];
      const replaced: string[] = [];
      const failures: string[] = [];
      let firstAssigned: string | undefined;
      for (const agentId of selected) {
        const agent = agents.find((item) => item.id === agentId)!;
        const previous = currentAssignment(agent.ref, provider.id, existing);
        try {
          await client.post(`/assign/${encode(agentId)}`, {
            account: id,
            ...(previous ? { replace: true } : {}),
          });
          firstAssigned ??= agent.ref;
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
      if (firstAssigned) recordNext(`启动：atrium start ${firstAssigned}`);
      else recordNext(`分配：atrium assign 名称 ${id}`);
      outro(
        summary
          ? `${saved}；${summary.replaceAll("\n", "；")}`
          : `${saved}，未分配；稍后用 atrium assign 名称 ${id}`,
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
