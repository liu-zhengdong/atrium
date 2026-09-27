#!/usr/bin/env node
// 命令行启动耗时守护（要点 k22）：在打包产物上跑 `atrium --help` 与读命令，
// 取中位数，超过阈值就失败。默认量本仓库 bin/atrium.mjs（需先 npm run dist）；
// --bin 指向装好的包（如 <前缀>/lib/node_modules/atrium/bin/atrium.mjs）。
//
//   node scripts/bench-cli.mjs [--bin <路径>] [--runs 9] [--limit 150] [-- 命令 …]
//
// 阈值也可用 ATRIUM_BENCH_LIMIT_MS 放宽（CI 机器慢）。先在临时数据目录与空闲端口上
// 起一个隔离服务，读命令（status、task ls）连着它量，量完停掉服务、删掉目录。
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values, positionals } = parseArgs({
  options: {
    bin: { type: "string", default: join(root, "bin", "atrium.mjs") },
    runs: { type: "string", default: "9" },
    limit: {
      type: "string",
      default: process.env.ATRIUM_BENCH_LIMIT_MS ?? "150",
    },
  },
  allowPositionals: true,
});
const runs = Math.max(1, Number(values.runs));
const limit = Number(values.limit);
const bin = resolve(values.bin);
if (!existsSync(bin)) {
  console.error(`没有找到命令行入口：${bin}`);
  process.exit(2);
}
if (!existsSync(join(dirname(bin), "..", "dist", "cli.js"))) {
  console.error(
    `${bin} 旁边没有编译产物 dist/cli.js；先运行 npm run dist，或用 --bin 指向装好的包`,
  );
  process.exit(2);
}

const commands = positionals.length
  ? [positionals]
  : [["--help"], ["status"], ["task", "ls"]];
const port = await new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolvePort(port));
  });
});
const data = mkdtempSync(join(tmpdir(), "atrium-bench-"));
const env = {
  ...process.env,
  // 仓库里也量编译产物，不量 tsx。
  ATRIUM_DIST: "1",
  ATRIUM_DATA: data,
  ATRIUM_PORT: String(port),
  // 不读本机的执行者档案与各家登录：量的是命令行，不依赖开发者主目录。
  ATRIUM_WORKERS_DIR: join(data, "no-workers"),
  ATRIUM_QUOTA_READERS: "off",
};
const atrium = (...args) =>
  spawnSync(process.execPath, [bin, ...args], { env, encoding: "utf8" });

function median(args) {
  const times = [];
  // 首次不计：磁盘缓存冷启动不代表常态。
  for (let i = 0; i <= runs; i++) {
    const start = process.hrtime.bigint();
    spawnSync(process.execPath, args, { env, stdio: "ignore" });
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    if (i > 0) times.push(ms);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

let failed = false;
try {
  const started = atrium("--no-open");
  if (started.status !== 0) {
    console.error(`隔离服务没起来：${started.stderr.trim()}`);
    try {
      console.error(readFileSync(join(data, "service.log"), "utf8"));
    } catch {}
    process.exitCode = 2;
    throw new Error("start");
  }
  const baseline = median(["-e", "0"]);
  console.log(`node -e 0  ${baseline.toFixed(0)} 毫秒（参照）`);
  for (const command of commands) {
    const ms = median([bin, ...command]);
    const over = ms > limit;
    failed ||= over;
    console.log(
      `atrium ${command.join(" ")}  ${ms.toFixed(0)} 毫秒${over ? `  超过 ${limit} 毫秒` : ""}`,
    );
  }
} catch (error) {
  if (error.message !== "start") throw error;
} finally {
  atrium("stop");
  rmSync(data, { recursive: true, force: true });
}
if (process.exitCode) process.exit();
if (failed) {
  console.error(
    `命令行启动超过 ${limit} 毫秒（中位数，${runs} 次）；机器忙时可用 ATRIUM_BENCH_LIMIT_MS 放宽后重跑`,
  );
  process.exit(1);
}
console.log(`通过：都在 ${limit} 毫秒内`);
