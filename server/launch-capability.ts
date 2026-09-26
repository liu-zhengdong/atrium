import { createRequire } from "node:module";
import { IDENTITY_LAUNCH_SECRET_CAPABILITY } from "../shared/runtime-capability.ts";
import { Problem } from "./problem.ts";

const require = createRequire(import.meta.url);

/** Require both the installed adapter's contract and this ACP child's affirmative reply. */
export function supportsIdentityLaunchSecret(meta: unknown): boolean {
  try {
    const adapter = require("@liuser/pi-atrium/dist/identity.js") as {
      IDENTITY_LAUNCH_SECRET_CAPABILITY?: unknown;
    };
    return (
      adapter.IDENTITY_LAUNCH_SECRET_CAPABILITY ===
        IDENTITY_LAUNCH_SECRET_CAPABILITY &&
      typeof meta === "object" &&
      meta !== null &&
      (meta as Record<string, unknown>)[IDENTITY_LAUNCH_SECRET_CAPABILITY] ===
        true
    );
  } catch {
    return false;
  }
}

export function assertIdentityLaunchSecretCapability(capable: boolean): void {
  if (capable) return;
  throw new Problem(
    409,
    "独立令牌启动需要新版 pi-atrium；请在 Atrium 安装目录执行 npm ci（按锁文件更新 pi-atrium），再运行 atrium restart；或为身份分配非共用登录的其他账号",
    "launch_secret_unsupported",
  );
}
