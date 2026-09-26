import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ProviderEntry, ProviderMethod } from "../shared/providers.ts";
import { mergeProviders, methodsFor } from "../shared/providers.ts";
import { defaultTemplate } from "./profile.ts";
import { templatePackagePath } from "./package-spec.ts";
import { Problem } from "./store.ts";
import type { AccountWorker } from "./account-worker-client.ts";

function stamp(path: string) {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "missing";
  }
}
/** Settings and installed package changes invalidate the shared worker result. */
function fingerprint(template: string) {
  const file = join(template, "settings.json");
  let packages: string[] = [];
  try {
    const settings = JSON.parse(readFileSync(file, "utf8"));
    packages = (settings.packages ?? []).map(
      (item: string | { source: string }) =>
        typeof item === "string" ? item : item.source,
    );
  } catch {
    /* The worker reports an invalid template instead. */
  }
  return [
    template,
    stamp(file),
    ...packages.flatMap((spec) => {
      let path: string;
      try {
        path = templatePackagePath(template, spec);
      } catch {
        return [spec, "invalid"];
      }
      let entrypoints: string[] = [];
      try {
        const manifest = JSON.parse(
          readFileSync(join(path, "package.json"), "utf8"),
        );
        entrypoints = (manifest.pi?.extensions ?? []).map((entry: string) =>
          resolve(path, entry),
        );
      } catch {
        /* Local extensions may not have a manifest. */
      }
      return [
        spec,
        stamp(path),
        stamp(join(path, "package.json")),
        stamp(join(path, "extensions")),
        ...entrypoints.flatMap((entry) => [entry, stamp(entry)]),
      ];
    }),
  ].join("|");
}

/** 内置供应商的静态条目：不执行模板插件也能判定存在性与方式（#230）。 */
function builtinProviderEntry(provider: string): ProviderEntry | null {
  const item = builtinProviders().find((entry) => entry.id === provider);
  if (!item) return null;
  return {
    id: item.id,
    name: item.name,
    methods: [item.auth.oauth && "oauth", item.auth.apiKey && "api_key"].filter(
      Boolean,
    ) as ProviderMethod[],
    packagePath: null,
  };
}

/** 目录失败的冷却时间：插件挂死时每个请求都等 30 秒太贵，冷却期内直接给同一结论（#230）。 */
const FAILURE_COOLDOWN = 60_000;

type DirectoryFailure = {
  fingerprint: string;
  reason: string;
  at: number;
};

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ProviderDirectory {
  private cache?: { fingerprint: string; providers: ProviderEntry[] };
  private failure?: DirectoryFailure;
  private pending?: Promise<ProviderEntry[]>;
  constructor(private worker: Pick<AccountWorker, "list">) {}
  async list(): Promise<ProviderEntry[]> {
    const template = defaultTemplate();
    const current = fingerprint(template);
    if (this.cache?.fingerprint === current) return this.cache.providers;
    if (
      this.failure?.fingerprint === current &&
      Date.now() - this.failure.at < FAILURE_COOLDOWN
    )
      throw new Error(this.failure.reason);
    if (this.pending) return this.pending;
    this.pending = this.worker
      .list(template)
      .then((entries) => {
        const providers = mergeProviders(
          entries.filter((entry) => entry.methods.length),
        );
        this.cache = { fingerprint: current, providers };
        this.failure = undefined;
        return providers;
      })
      .catch((error: unknown) => {
        this.failure = {
          fingerprint: current,
          reason: reasonOf(error),
          at: Date.now(),
        };
        throw error;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
  async require(
    provider: string,
    method: ProviderMethod,
  ): Promise<ProviderEntry> {
    // 内置供应商先按静态清单判定：模板插件挂死时，内置账号照常能加（#230）。
    const builtin = builtinProviderEntry(provider);
    if (builtin && methodsFor(builtin, method).length) return builtin;
    try {
      const entries = await this.list();
      const entry = entries.find((item) => item.id === provider);
      if (!entry || !methodsFor(entry, method).length)
        throw new Problem(400, `供应商不存在或不支持此方式：${provider}`);
      if (entry.packagePath && !existsSync(entry.packagePath))
        throw new Problem(400, `供应商插件不可用：${provider}`);
      return entry;
    } catch (error) {
      // 目录不可用时再看一次静态清单；插件供应商给出带原因的 400，不再落到被隐去细节的 500（#230）。
      if (builtin && methodsFor(builtin, method).length) return builtin;
      if (error instanceof Problem) throw error;
      throw new Problem(
        400,
        `供应商插件不可用：${provider}（${reasonOf(error)}）`,
      );
    }
  }
}
