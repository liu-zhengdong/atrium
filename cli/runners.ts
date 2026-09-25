import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { dataDirectory } from "../server/service-state.ts";
import { Problem } from "../server/problem.ts";
import type { Command } from "./main.ts";
import { recordResult } from "./contract.ts";
import type { Client } from "./service.ts";

const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
function credentialFile(ref: string) {
  if (!/^r[1-9][0-9]*$/.test(ref))
    throw new Problem(400, "运行器编号应为 r1 等短号", "usage");
  return join(dataDirectory(), "runners", `${ref}.token`);
}
async function provision(
  action: (
    client: Client,
    tokenHash: string,
  ) => Promise<{ runnerId: string; credentialId: string }>,
) {
  const dir = join(dataDirectory(), "runners");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  const temp = join(dir, `.${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(temp, `${token}\n`, { flag: "wx", mode: 0o600 });
    const { connect } = await import("./service.ts");
    const result = await action(await connect(), hash(token));
    const file = credentialFile(result.runnerId);
    renameSync(temp, file);
    chmodSync(file, 0o600);
    recordResult({ ...result, file });
    return { ...result, file };
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

export const runnerCommands: Record<string, Command> = {
  "runner list": {
    args: "",
    about: "查看本地运行器身份（不显示令牌）",
    positionals: [0, 0],
    run: async () => {
      const { connect } = await import("./service.ts");
      const rows = await (
        await connect()
      ).get<
        { runnerId: string; name: string; state: string; pending: number }[]
      >("/runners");
      for (const row of rows)
        console.log(
          `${row.runnerId}\t${row.name}\t${row.state}${row.pending ? " · 新凭据待连接" : ""}`,
        );
    },
  },
  "runner issue": {
    args: "<名称>",
    about: "颁发机器身份；令牌只写入当前数据目录的受限文件",
    positionals: [1, 1],
    run: async ({ positionals }) => {
      const { runnerId, file } = await provision((client, tokenHash) =>
        client.post("/runners", { name: positionals[0], tokenHash }),
      );
      console.log(
        `运行器 ${runnerId} 已颁发；凭据文件：${file}（0600）。请安全复制到目标机器。`,
      );
    },
  },
  "runner rotate": {
    args: "<r编号>",
    about: "签发待生效的新凭据；首次用新凭据连接时旧凭据立即失效",
    positionals: [1, 1],
    run: async ({ positionals }) => {
      const ref = positionals[0]!;
      credentialFile(ref);
      const { file } = await provision((client, tokenHash) =>
        client.post(`/runners/${ref}/rotate`, { tokenHash }),
      );
      console.log(
        `${ref} 新凭据待连接；凭据文件：${file}（0600）。旧连接在新连接认证后应关闭。`,
      );
    },
  },
  "runner revoke": {
    args: "<r编号>",
    about: "撤销机器身份及所有凭据",
    positionals: [1, 1],
    run: async ({ positionals }) => {
      const ref = positionals[0]!;
      const file = credentialFile(ref);
      const { connect } = await import("./service.ts");
      await (await connect()).post(`/runners/${ref}/revoke`);
      if (existsSync(file)) unlinkSync(file);
      console.log(`${ref} 已撤销`);
    },
  },
};
