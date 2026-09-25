import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { privateWrite, providerName } from "./account-files.ts";
import { Problem } from "./store.ts";

export const customSchema = z
  .object({
    baseUrl: z.string().url(),
    models: z
      .array(
        z.object({
          id: z.string().trim().min(1),
          reasoning: z.boolean().optional(),
          contextWindow: z.number().int().min(1024).optional(),
        }),
      )
      .min(1),
    supportsDeveloperRole: z.boolean().optional(),
    supportsReasoningEffort: z.boolean().optional(),
  })
  .strict();
export type CustomConfig = z.infer<typeof customSchema>;
export function checkedCustom(name: string, config: CustomConfig) {
  providerName.parse(name);
  const parsed = customSchema.parse(config);
  const url = new URL(parsed.baseUrl);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    (url.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    throw new Problem(400, "Base URL 须为 HTTPS；本地服务可用 HTTP");
  if (url.username || url.password || url.search || url.hash)
    throw new Problem(400, "Base URL 不可包含凭据、查询或片段");
  return { ...parsed, baseUrl: url.href.replace(/\/$/, "") };
}
export function modelEntry(config: CustomConfig) {
  return {
    baseUrl: config.baseUrl,
    api: "openai-completions",
    compat: {
      supportsDeveloperRole: config.supportsDeveloperRole ?? false,
      supportsReasoningEffort: config.supportsReasoningEffort ?? false,
    },
    models: config.models.map((m) => ({
      id: m.id,
      reasoning: m.reasoning ?? false,
      contextWindow: m.contextWindow ?? 128000,
    })),
  };
}
export class CustomProviders {
  readonly file: string;
  constructor(data: string) {
    this.file = join(data, "custom-providers.json");
  }
  all(): Record<string, CustomConfig> {
    if (!existsSync(this.file)) return {};
    return JSON.parse(readFileSync(this.file, "utf8")) as Record<
      string,
      CustomConfig
    >;
  }
  get(id: string): CustomConfig | undefined {
    return this.all()[id];
  }
  save(id: string, config: CustomConfig) {
    privateWrite(this.file, { ...this.all(), [id]: config });
  }
  remove(id: string) {
    const all = this.all();
    delete all[id];
    privateWrite(this.file, all);
  }
}
