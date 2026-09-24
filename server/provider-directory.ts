import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
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

export class ProviderDirectory {
  private cache?: { fingerprint: string; providers: ProviderEntry[] };
  private pending?: Promise<ProviderEntry[]>;
  constructor(private worker: Pick<AccountWorker, "list">) {}
  async list(): Promise<ProviderEntry[]> {
    const template = defaultTemplate();
    const current = fingerprint(template);
    if (this.cache?.fingerprint === current) return this.cache.providers;
    if (this.pending) return this.pending;
    this.pending = this.worker
      .list(template)
      .then((entries) => {
        const providers = mergeProviders(
          entries.filter((entry) => entry.methods.length),
        );
        this.cache = { fingerprint: current, providers };
        return providers;
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
    const entry = (await this.list()).find((item) => item.id === provider);
    if (!entry || !methodsFor(entry, method).length)
      throw new Problem(400, `供应商不存在或不支持此方式：${provider}`);
    if (entry.packagePath && !existsSync(entry.packagePath))
      throw new Problem(400, `供应商插件不可用：${provider}`);
    return entry;
  }
}
