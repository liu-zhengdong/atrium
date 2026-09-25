import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  dataDirectory,
  readService,
  serviceUrl,
  type ServiceRecord,
} from "../server/service-state.ts";
import { userTokenPath } from "../server/user-auth.ts";
import { startService, openWeb } from "../server/service.ts";
import { Problem } from "../server/problem.ts";
import { recordResult } from "./contract.ts";
import type { Command } from "./main.ts";

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
export function webAddress(port: number) {
  return `http://atrium.localhost:${port}`;
}
export async function loginLink(data: string, record: ServiceRecord) {
  const response = await fetch(`${serviceUrl(record)}/api/auth/link`, {
    method: "POST",
    headers: { authorization: userBearer(data) },
  });
  if (!response.ok)
    throw new Problem(
      response.status,
      `用户认证失效（数据：${data}）；请运行 atrium auth rotate`,
      "auth_required",
      undefined,
      "atrium auth rotate",
    );
  const { code } = (await response.json()) as { code: string };
  return `${webAddress(record.port)}/auth/claim/${code}`;
}
const tokenFile = (data: string, agent: string) =>
  join(data, "hooks", `${agent}.token`);
function readHook(data: string, agent: string) {
  try {
    return readFileSync(tokenFile(data, agent), "utf8").trim();
  } catch {
    return null;
  }
}
function writeHook(data: string, agent: string, token: string) {
  const dir = join(data, "hooks");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = tokenFile(data, agent);
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, `${token}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
    chmodSync(path, 0o600);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export const authCommands: Record<string, Command> = {
  open: {
    args: "[--print]",
    about: "生成一次性链接并登录 Web；--print 只输出链接，不打开浏览器",
    options: { print: { type: "boolean", default: false } },
    positionals: [0, 0],
    run: async ({ values, json }) => {
      const data = dataDirectory();
      const record = await startService(data);
      if (json) {
        recordResult({ ready: true, address: webAddress(record.port) });
        return;
      }
      const url = await loginLink(data, record);
      if (values.print) console.log(url);
      else {
        await openWeb(record, url);
        console.log("已打开 Web；链接仅可使用一次，有效期 60 秒");
      }
    },
  },
  "auth rotate": {
    args: "",
    about:
      "轮换用户令牌并让全部 Web 会话失效；令牌丢失时凭本机实例控制凭据恢复",
    positionals: [0, 0],
    run: async () => {
      const data = dataDirectory();
      const record = await startService(data);
      const url = `${serviceUrl(record)}/api/auth/rotate`;
      const rotate = (token: string) =>
        fetch(url, {
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
          `无法轮换用户令牌（数据：${data}）；确认 ATRIUM_DATA 与服务相同，并检查实例控制文件 service.sqlite`,
          "auth_required",
          undefined,
          "atrium auth rotate",
        );
      console.log(`用户令牌已轮换；全部 Web 会话已失效\n数据：${data}`);
      recordResult({ rotated: true, data });
    },
  },
  "adapters url": {
    args: "身份 [--rotate|--revoke]",
    about: "显示、轮换或撤销该身份的外部推送地址（地址是仅可写消息箱的秘密）",
    options: {
      rotate: { type: "boolean", default: false },
      revoke: { type: "boolean", default: false },
    },
    positionals: [1, 1],
    run: async ({ positionals, values, json }) => {
      if (values.rotate && values.revoke)
        throw new Problem(400, "--rotate 与 --revoke 不能同时用", "usage");
      if (json)
        throw new Problem(
          400,
          "推送地址是秘密，--json 不输出该地址；请去掉 --json",
          "usage",
        );
      const { connect } = await import("./service.ts");
      const client = await connect();
      const ref = encodeURIComponent(positionals[0]!);
      const current = await client.get<{
        agent: string;
        tokenHash: string | null;
      }>(`/agents/${ref}/adapters/url`);
      if (values.revoke) {
        await client.put(`/agents/${ref}/adapters/url`, { tokenHash: null });
        const file = tokenFile(dataDirectory(), current.agent);
        if (existsSync(file)) unlinkSync(file);
        console.log(`已撤销 ${current.agent} 的推送地址`);
        return;
      }
      let token = readHook(dataDirectory(), current.agent);
      if (values.rotate || !token || hash(token) !== current.tokenHash) {
        token = randomBytes(32).toString("hex");
        // Persist locally before installing the hash; interrupted writes are recoverable by --rotate.
        writeHook(dataDirectory(), current.agent, token);
        await client.put(`/agents/${ref}/adapters/url`, {
          tokenHash: hash(token),
        });
      }
      const record = readService(dataDirectory());
      if (!record) throw new Problem(503, "服务未就绪", "service_unavailable");
      console.log(`${webAddress(record.port)}/hooks/${current.agent}/${token}`);
    },
  },
};
