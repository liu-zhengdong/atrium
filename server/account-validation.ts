import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AccountWorker } from "./account-worker-client.ts";
import { authFile, privateWrite } from "./account-files.ts";
import { defaultTemplate } from "./profile.ts";
import { modelEntry, type CustomConfig } from "./custom-providers.ts";
import type { ProviderEntry } from "../shared/providers.ts";

export type Validation = {
  status: "verified" | "unverified" | "rejected" | "skipped";
  reason?: string;
};

/** Preserve the service's useful message, not its JSON envelope or request metadata. */
export function validationReason(reason?: string): string {
  if (!reason) return "请求失败";
  const match = reason.match(/\b(401|403)\s*:\s*(\{.*\})/s);
  if (!match) return reason;
  try {
    const body = JSON.parse(match[2]!) as {
      message?: string;
      error?: { message?: string };
    };
    const message = body.message ?? body.error?.message;
    if (!message) return reason;
    return `${match[1]}：${message.replace(/\s*\(request_id:\s*[^)]*\)/gi, "").trim()}`;
  } catch {
    return reason;
  }
}

// Credentials are written only to a short-lived private directory, never sent over IPC.
export async function validateKey(
  worker: AccountWorker,
  provider: ProviderEntry,
  key: string,
  custom?: CustomConfig,
): Promise<Validation> {
  if (
    !custom &&
    ["amazon-bedrock", "google-vertex", "azure-openai"].includes(provider.id)
  )
    return {
      status: "skipped",
      reason: "需要额外环境配置，无法仅凭 API Key 校验",
    };
  const directory = mkdtempSync(join(tmpdir(), "atrium-key-check-"));
  try {
    const template = defaultTemplate();
    if (!custom && existsSync(join(template, "settings.json")))
      copyFileSync(
        join(template, "settings.json"),
        join(directory, "settings.json"),
      );
    privateWrite(authFile(directory), {
      [provider.id]: { type: "api_key", key },
    });
    if (custom)
      privateWrite(join(directory, "models.json"), {
        providers: { [provider.id]: modelEntry(custom) },
      });
    return await worker.validate(directory, provider.id, key);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
