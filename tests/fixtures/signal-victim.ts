/**
 * tests/fixture-signal.test.ts 的受害者进程（#222）：
 * 与各测试夹具同法拉起真实后台服务（detached），
 * 把进程树和临时目录以一行 JSON 报告给父进程后挂住，等待被信号打断。
 * VICTIM_NO_CLEANUP=1 时不登记中断收尾，用于反向对照（复现泄漏）。
 */
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { alive, packageRoot, readService } from "../../server/service-state.ts";
import { descendantsOf, trackFixture } from "../fixture-signal.ts";
import { childEnv } from "../child-env.ts";

const exec = promisify(execFile);
const root = mkdtempSync(join(tmpdir(), "atrium-sigvictim-"));
const data = join(root, "data");
if (process.env.VICTIM_NO_CLEANUP !== "1") trackFixture(data, root);
const socket = createServer();
await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = (socket.address() as { port: number }).port;
await new Promise<void>((resolve) => socket.close(() => resolve()));
const template = join(root, "pi-template");
mkdirSync(template);
writeFileSync(join(template, "settings.json"), '{"packages":[]}');
writeFileSync(join(template, "SYSTEM.md"), "victim rules");
const env: NodeJS.ProcessEnv = childEnv({
  ATRIUM_DATA: data,
  ATRIUM_PORT: String(port),
  ATRIUM_DESKTOPS: join(root, "desktops"),
  ATRIUM_PI_HOME: join(root, ".pi"),
  ATRIUM_PI_TEMPLATE: template,
  PI_ACP_DIR: join(root, "acp"),
});
const cli = (...args: string[]) =>
  exec(process.execPath, [join(packageRoot, "bin/atrium.mjs"), ...args], {
    env,
    cwd: root,
    timeout: 60000,
  });
await cli("task", "ls"); // 第一条经服务的命令把 detached 服务拉起来
const record = readService(data);
if (!record || !alive(record.pid)) throw new Error("服务没有起来");
// 组织运行时空闲时不开子进程；有就一并报告，收尾时整棵树都要带走。
const descendants = descendantsOf(record.pid);
process.stdout.write(
  JSON.stringify({ root, pid: record.pid, descendants }) + "\n",
);
setInterval(() => {}, 1000);
