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
    "独立令牌启动需要新版 pi-atrium；全局安装请运行 atrium update，源码安装请在仓库执行 npm ci，随后运行 atrium restart；或为身份分配非共用登录的其他账号",
    "launch_secret_unsupported",
  );
}
