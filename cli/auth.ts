import { readFileSync } from "node:fs";
import {
  dataDirectory,
  readService,
  serviceUrl,
  type ServiceRecord,
} from "../server/service-state.ts";
import { userTokenPath } from "../server/user-auth.ts";
import { startService } from "../server/service.ts";
import { Problem } from "../server/problem.ts";
import { localFetch } from "../server/local-http.ts";
import { recordResult } from "./contract.ts";
import type { Command } from "./main.ts";

async function serviceStatus(record: ServiceRecord) {
  const response = await localFetch(`${serviceUrl(record)}/api/service`, {
    headers: { authorization: `Bearer ${record.token}` },
    signal: AbortSignal.timeout(1500),
  }).catch(() => {
    throw new Problem(503, "服务不可用或身份校验失败", "service_unavailable");
  });
  if (!response.ok)
    throw new Problem(503, "服务不可用或身份校验失败", "service_unavailable");
  const status = (await response.json()) as {
    instance?: string;
    userAuth?: string;
    stopping?: boolean;
  };
  if (status.instance !== record.instance)
    throw new Problem(503, "服务身份不匹配", "service_unavailable");
  return status;
}
async function supportsUserAuth(record: ServiceRecord) {
  return (await serviceStatus(record)).userAuth === "user-v1";
}
export async function requireUserAuthService(record: ServiceRecord) {
  const status = await serviceStatus(record);
  if (status.userAuth !== "user-v1")
    throw new Problem(
      409,
      "已安装新版本，但当前服务仍在运行旧版本；请运行 atrium restart 完成升级",
      "upgrade_restart_required",
      undefined,
      "atrium restart",
    );
  // #231：服务卡在 stopping 时给出明确的下一步，不再只报连不上。
  if (status.stopping)
    throw new Problem(
      409,
      "服务正在平滑重启或关闭中；有进行中的重启时运行 atrium restart --wait 等结果，没有时运行 atrium restart 接管升级",
      "service_stopping",
      undefined,
      "atrium restart --wait",
    );
}

function localToken(data: string) {
  try {
    const token = readFileSync(userTokenPath(data), "utf8").trim();
    return /^[a-f0-9]{64}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}
export function userBearer(data: string) {
  const token = localToken(data);
  if (!token)
    throw new Problem(
      401,
      `用户令牌缺失或无效（数据：${data}）；请运行 atrium auth rotate`,
      "auth_required",
      undefined,
      "atrium auth rotate",
    );
  return `Bearer ${token}`;
}
export const authCommands: Record<string, Command> = {
  "auth status": {
    args: "",
    about: "查看当前本机用户身份、认证状态和连接的服务（不启动服务）",
    positionals: [0, 0],
    run: async ({ json }) => {
      const data = dataDirectory();
      const record = readService(data);
      const token = localToken(data);
      let connected = false;
      let authenticated = false;
      let upgradeRequired = false;
      if (record) {
        try {
          connected = true;
          upgradeRequired = !(await supportsUserAuth(record));
          if (!upgradeRequired && token) {
            const check = await localFetch(
              `${serviceUrl(record)}/api/org/tree`,
              {
                headers: { authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(1500),
              },
            );
            authenticated = check.ok;
          }
        } catch {
          connected = false;
        }
      }
      const result = {
        user: "u1",
        scope: "local",
        service: connected && record ? serviceUrl(record) : null,
        data,
        authenticated,
        ...(upgradeRequired ? { upgradeRequired: true } : {}),
      };
      recordResult(result);
      if (!json)
        console.log(
          `当前：本机用户 u1\n服务：${result.service ?? "未连接"}\n认证：${upgradeRequired ? "服务还在运行旧版本 · 请运行 atrium restart" : authenticated ? "有效" : "未认证 · 请运行 atrium auth rotate"}\n数据：${data}`,
        );
    },
  },
  "auth rotate": {
    args: "",
    about: "轮换用户令牌；令牌丢失时凭本机实例控制凭据恢复",
    positionals: [0, 0],
    run: async () => {
      const data = dataDirectory();
      const record = await startService(data, { launch: false });
      await requireUserAuthService(record);
      const url = `${serviceUrl(record)}/api/auth/rotate`;
      const rotate = (token: string) =>
        localFetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        });
      const token = localToken(data);
      let response = token ? await rotate(token) : undefined;
      if (!response || response.status === 401)
        response = await rotate(record.token);
      if (!response.ok)
        throw new Problem(
          response.status,
          `无法轮换用户令牌（数据：${data}）；确认 ATRIUM_DATA 与服务相同，并检查实例控制文件 service.sqlite；运行 atrium status 排查服务`,
          "service_unavailable",
          undefined,
          "atrium status",
        );
      console.log(`用户令牌已轮换\n数据：${data}`);
      recordResult({ rotated: true, data });
    },
  },
};
