import {
  builtinProviders,
  getBuiltinModels,
  type BuiltinProvider,
} from "@earendil-works/pi-ai/providers/all";
import type { ProviderEntry, ProviderMethod } from "../shared/providers.ts";
import { methodsFor, retiredProvider } from "../shared/providers.ts";
import { Problem } from "./store.ts";

/**
 * Atrium 自己维护的供应商列表（#242）：登录、刷新和请求协议都用 Pi 自带实现，
 * 不看个人模板里装了哪些插件。Claude 走运行器（#193），不在这里。
 */
export const SUPPORTED_PROVIDERS = [
  "openai-codex",
  "xai",
  "kimi-coding",
  "opencode-go",
] as const satisfies readonly BuiltinProvider[];

/**
 * Pi 自带模型表里还没有的模型，分配账号时写进身份的 models.json。
 * 定义取自原插件给出的目录：gpt-6-sol 来自 pi-better-openai 拉取的 openai-codex
 * 目录，grok-4.7 来自 pi-xai-oauth 缓存的账号目录；Pi 自带了同名模型就不再补。
 * 不写 baseUrl：跟随供应商（及身份配置的代理地址），与 Pi 自带模型走同一个端点。
 */
const SUPPLEMENT_MODELS: Partial<
  Record<(typeof SUPPORTED_PROVIDERS)[number], Record<string, unknown>[]>
> = {
  "openai-codex": [
    {
      id: "gpt-6-sol",
      name: "GPT-6 Sol",
      api: "openai-codex-responses",
      reasoning: true,
      input: ["text", "image"],
      cost: {
        input: 2,
        output: 10,
        cacheRead: 0.2,
        cacheWrite: 2.5,
        tiers: [
          {
            inputTokensAbove: 272000,
            input: 4,
            output: 15,
            cacheRead: 0.4,
            cacheWrite: 5,
          },
        ],
      },
      contextWindow: 272000,
      maxTokens: 128000,
      thinkingLevelMap: {
        off: "none",
        minimal: "low",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      },
      compat: {
        supportsOpenAIGrammarTools: true,
        supportsAdditionalTools: true,
        supportsToolSearch: true,
        supportsMidConvoSystemMessages: true,
      },
    },
  ],
  xai: [
    {
      id: "grok-4.7",
      name: "Grok 4.7",
      api: "openai-responses",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 500000,
      maxTokens: 16384,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: null,
      },
      compat: { supportsLongCacheRetention: false },
    },
  ],
};

const supported = (id: string): id is (typeof SUPPORTED_PROVIDERS)[number] =>
  (SUPPORTED_PROVIDERS as readonly string[]).includes(id);

/** 这个供应商要补进身份 models.json 的条目；不需要补时为 null。 */
export function supplementEntry(provider: string) {
  if (!supported(provider)) return null;
  const builtin = new Set(getBuiltinModels(provider).map((model) => model.id));
  const models = (SUPPLEMENT_MODELS[provider] ?? []).filter(
    (model) => !builtin.has(model.id as string),
  );
  return models.length ? { models } : null;
}

/** 列表里的供应商 id 与合法写法；报错时给调用方看。 */
const listed = () => SUPPORTED_PROVIDERS.join("、");

export class ProviderDirectory {
  private entries?: ProviderEntry[];
  list(): ProviderEntry[] {
    this.entries ??= builtinProviders()
      .filter((item) => supported(item.id))
      .map((item) => ({
        id: item.id,
        name: item.name,
        methods: [
          ...(item.auth.oauth ? (["oauth"] as const) : []),
          ...(item.auth.apiKey ? (["api_key"] as const) : []),
        ],
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return this.entries;
  }
  require(provider: string, method: ProviderMethod): ProviderEntry {
    const retired = retiredProvider(provider);
    if (retired)
      throw new Problem(
        400,
        retired.reason,
        "provider_retired",
        undefined,
        retired.fix,
      );
    const entry = this.list().find((item) => item.id === provider);
    if (!entry)
      throw new Problem(
        400,
        `供应商不存在：${provider}。可用：${listed()}，或自定义兼容供应商`,
        "provider_not_found",
        undefined,
        "atrium connect",
      );
    if (!methodsFor(entry, method).length)
      throw new Problem(
        400,
        `${entry.name} 不支持${method === "oauth" ? "账号登录" : "API Key"}，只支持${entry.methods.map((item) => (item === "oauth" ? "账号登录" : "API Key")).join("、")}`,
        "usage",
        undefined,
        `atrium connect ${entry.id}`,
      );
    return entry;
  }
}
