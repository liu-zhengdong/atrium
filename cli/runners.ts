import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { dataDirectory, servicePort } from "../server/service-state.ts";
import { RunnerDaemon } from "../server/runner-daemon.ts";
import { Problem } from "../server/problem.ts";
import type { Command } from "./main.ts";
import { recordResult } from "./contract.ts";
import type { Client } from "./service.ts";
import { findAgent, roster } from "./agents.ts";
import { migrateRunner } from "./runner-migration.ts";

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
  "runner bind": {
    args: "<身份> <r编号>",
    about: "停止身份后交给指定本地运行器；下次启动由运行器持有会话",
    positionals: [2, 2],
    run: async ({ positionals: [reference, runnerId] }) => {
      credentialFile(runnerId!);
      const { connect } = await import("./service.ts");
      const client = await connect();
      const agent = findAgent(await roster(client), reference!);
      await client.put(`/agents/${agent.id}/runner`, { runnerId });
      console.log(
        `${agent.name} 已归属 ${runnerId}；运行 atrium start ${agent.ref} 启动会话`,
      );
    },
  },
  "runner migrate": {
    args: "<r编号> [--timeout 秒]",
    about: "首次逐个交接旧身份；忙碌时列出等待项，到期跳过，不打断回合",
    options: { timeout: { type: "string", default: "300" } },
    positionals: [1, 1],
    run: async ({ positionals: [runnerId], values }) => {
      credentialFile(runnerId!);
      const timeout = Number(values.timeout);
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600)
        throw new Problem(400, "timeout 应为 1–600 秒", "usage");
      const result = await migrateRunner(
        await (await import("./service.ts")).connect(),
        runnerId!,
        timeout,
      );
      recordResult(result);
      if (result.failed.length || result.skipped.length)
        throw new Problem(
          409,
          "部分身份尚未迁移；上方已列出可继续操作的身份",
          "conflict",
        );
    },
  },
  "runner unbind": {
    args: "<身份>",
    about: "停止身份后取消运行器归属；回到本地服务直接管理",
    positionals: [1, 1],
    run: async ({ positionals: [reference] }) => {
      const { connect } = await import("./service.ts");
      const client = await connect();
      const agent = findAgent(await roster(client), reference!);
      await client.delete(`/agents/${agent.id}/runner`);
      console.log(`${agent.name} 已取消运行器归属`);
    },
  },
  "runner start": {
    args: "<r编号>",
    about: "运行独立身份进程；服务重启时仍保留会话和回合",
    positionals: [1, 1],
    run: async ({ positionals }) => {
      const runnerId = positionals[0]!;
      const file = credentialFile(runnerId);
      const token = readFileSync(file, "utf8").trim();
      if (!/^[a-f0-9]{64}$/.test(token))
        throw new Problem(400, "运行器凭据格式无效", "usage");
      const url = `ws://127.0.0.1:${servicePort()}/runner/v1`;
      const daemon = new RunnerDaemon(
        url,
        token,
        process.env,
        join(dataDirectory(), "runners", `${runnerId}.state.json`),
      );
      const stop = () => daemon.close();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      console.log(
        `${runnerId} 本地运行器正在启动（当前进程 ${process.pid}）；停止请向本进程发 SIGTERM`,
      );
      try {
        await daemon.run();
      } finally {
        daemon.close();
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
    },
  },
  "runner reclaim": {
    args: "<身份> [--confirm-stopped]",
    about:
      "核实并停止旧身份进程，然后恢复本机运行器归属；状态文件丢失时先人工核查再确认",
    options: { "confirm-stopped": { type: "boolean", default: false } },
    positionals: [1, 1],
    run: async ({ positionals: [reference], values }) => {
      const { connect } = await import("./service.ts");
      const client = await connect();
      const agent = findAgent(await roster(client), reference!);
      await client.post(`/agents/${agent.id}/runner/reclaim`, {
        confirmStopped: values["confirm-stopped"] === true,
      });
      console.log(
        `${agent.name} 的旧进程已核实退出，运行器归属恢复；可运行 atrium start ${agent.ref} 恢复会话`,
      );
    },
  },
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
        `本机运行器 ${runnerId} 已颁发；凭据文件：${file}（0600）。运行 atrium runner start ${runnerId} 启动。`,
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
