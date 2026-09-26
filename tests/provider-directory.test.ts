import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import {
  alive,
  packageRoot,
  readService,
  serviceUrl,
} from "../server/service-state.ts";
import { userTokenPath } from "../server/user-auth.ts";
import { ProviderDirectory } from "../server/provider-directory.ts";

const exec = promisify(execFile);

/** 模板目录夹具：指纹读 settings.json，路径由 ATRIUM_PI_TEMPLATE 指定。 */
function makeTemplate(root: string, packages: string[]) {
  const template = join(root, "template");
  mkdirSync(template, { recursive: true });
  writeFileSync(join(template, "settings.json"), JSON.stringify({ packages }));
  return template;
}

test("内置供应商不等模板插件：目录挂死也按静态清单立即判定", async () => {
  const root = mkdtempSync(join(tmpdir(), "atrium-pd-fast-"));
  const template = makeTemplate(root, []);
  const old = process.env.ATRIUM_PI_TEMPLATE;
  process.env.ATRIUM_PI_TEMPLATE = template;
  let calls = 0;
  const directory = new ProviderDirectory({
    list: () => {
      calls += 1;
      return new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("目录挂死，不应被等待")),
          60_000,
        );
        timer.unref?.();
      });
    },
  });
  try {
    const startedAt = Date.now();
    const entry = await directory.require("kimi-coding", "api_key");
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 5_000, `内置判定应立即返回，实际等了 ${elapsedMs}ms`);
    assert.equal(calls, 0, "内置判定不应触发模板目录加载");
    assert.equal(entry.packagePath, null);
    assert.ok(entry.methods.includes("api_key"));
  } finally {
    if (old === undefined) delete process.env.ATRIUM_PI_TEMPLATE;
    else process.env.ATRIUM_PI_TEMPLATE = old;
    rmSync(root, { recursive: true, force: true });
  }
});

test("目录失败带原因：插件供应商给 400，失败在冷却期内不重跑", async () => {
  const root = mkdtempSync(join(tmpdir(), "atrium-pd-fail-"));
  const template = makeTemplate(root, ["hang-pkg"]);
  const old = process.env.ATRIUM_PI_TEMPLATE;
  process.env.ATRIUM_PI_TEMPLATE = template;
  const failure =
    "供应商目录加载失败：等待 30 秒未完成，卡在「加载插件」（模板插件：hang-pkg）";
  let calls = 0;
  const directory = new ProviderDirectory({
    list: () => {
      calls += 1;
      return Promise.reject(new Error(failure));
    },
  });
  try {
    await assert.rejects(
      () => directory.require("some-plugin-provider", "api_key"),
      (error: Error) => {
        assert.match(error.message, /供应商插件不可用：some-plugin-provider/);
        assert.match(error.message, /卡在「加载插件」/);
        return true;
      },
      "目录失败应转成带原因的 400 文案",
    );
    await assert.rejects(() => directory.list(), new Error(failure));
    assert.equal(calls, 1, "第一次失败");
    await assert.rejects(() => directory.list(), new Error(failure));
    assert.equal(calls, 1, "冷却期内的第二次直接复用结论，不再等 30 秒");
    // 内置供应商在目录失败时照常可用
    const entry = await directory.require("amazon-bedrock", "api_key");
    assert.equal(entry.packagePath, null);
    assert.equal(calls, 1);
  } finally {
    if (old === undefined) delete process.env.ATRIUM_PI_TEMPLATE;
    else process.env.ATRIUM_PI_TEMPLATE = old;
    rmSync(root, { recursive: true, force: true });
  }
});

/** 服务级夹具：挂死插件模板 + 隔离服务，stop 后能重启。 */
async function serviceFixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = mkdtempSync(join(tmpdir(), "atrium-provider-hang-"));
  const data = join(root, "data");
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const template = join(root, "template");
  const plugin = join(template, "hang-pkg");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(
    join(plugin, "package.json"),
    JSON.stringify({
      name: "hang-pkg",
      version: "1.0.0",
      pi: { extensions: ["ext.mjs"] },
    }),
  );
  const pidFile = join(root, "hang-grandchild.pid");
  // 扩展加载即派生孙进程然后永不返回：模拟模板里挂死的插件（#230）。
  writeFileSync(
    join(plugin, "ext.mjs"),
    `import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
export default function hang() {
  const child = spawn("sleep", ["120"], { stdio: "ignore" });
  const tmp = ${JSON.stringify(pidFile)} + ".tmp";
  writeFileSync(tmp, String(child.pid));
  renameSync(tmp, ${JSON.stringify(pidFile)});
  return new Promise(() => {});
}
`,
  );
  writeFileSync(
    join(template, "settings.json"),
    JSON.stringify({ packages: [plugin] }),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ATRIUM_DATA: data,
    ATRIUM_PORT: String(port),
    ATRIUM_DESKTOPS: join(root, "desktops"),
    ATRIUM_PI_HOME: join(root, ".pi"),
    ATRIUM_PI_TEMPLATE: template,
    PI_ACP_DIR: join(root, "acp"),
  };
  const cli = async (...args: string[]) => {
    try {
      const output = await exec(
        process.execPath,
        [join(packageRoot, "bin/atrium.mjs"), ...args],
        { env, cwd: root, timeout: 45000 },
      );
      return { ...output, code: 0 };
    } catch (error) {
      const failure = error as Error & {
        stdout: string;
        stderr: string;
        code: number;
      };
      return {
        stdout: failure.stdout,
        stderr: failure.stderr,
        code: failure.code,
      };
    }
  };
  t.after(async () => {
    await cli("stop");
    const record = readService(data);
    if (record && record.pid !== process.pid && alive(record.pid))
      process.kill(record.pid, "SIGKILL");
    const grandchild = Number(
      existsSync(pidFile) ? readFileSync(pidFile, "utf8") : 0,
    );
    if (grandchild > 1)
      try {
        process.kill(grandchild, "SIGKILL");
      } catch {
        /* 已死 */
      }
    rmSync(root, { recursive: true, force: true });
  });
  const headers = () => ({
    authorization: `Bearer ${readFileSync(userTokenPath(data), "utf8").trim()}`,
    "content-type": "application/json",
  });
  const base = () => `${serviceUrl(readService(data)!)}/api`;
  const grandchildPid = () =>
    Number(existsSync(pidFile) ? readFileSync(pidFile, "utf8") : 0);
  return { root, data, env, cli, headers, base, grandchildPid };
}

test("挂死模板里加内置账号：秒级完成（不等供应商目录）", async (t) => {
  const f = await serviceFixture(t);
  await f.cli("list"); // 拉起服务
  const startedAt = Date.now();
  const response = await fetch(`${f.base()}/accounts`, {
    method: "POST",
    headers: f.headers(),
    body: JSON.stringify({
      provider: "amazon-bedrock",
      name: "挂死模板内置账号",
      key: "FAKE_KEY",
    }),
  });
  const elapsedMs = Date.now() - startedAt;
  const body = (await response.json()) as { id?: number; message?: string };
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.ok(body.id, `应已保存：${JSON.stringify(body)}`);
  assert.ok(
    elapsedMs < 15_000,
    `内置账号应在秒级加上（当前实现会先等目录 30 秒），实际 ${elapsedMs}ms`,
  );
});

test("挂死模板的供应商目录：报错带原因，stop 不再干等，不留孤儿", async (t) => {
  const f = await serviceFixture(t);
  await f.cli("list");
  // 目录请求在后台挂着（首个请求与启动预加载共用同一次加载）
  const pending = fetch(`${f.base()}/providers`, { headers: f.headers() });
  pending.catch(() => undefined);
  // 等扩展加载真的发生：孙进程 pid 文件出现
  let started = false;
  for (let i = 0; i < 100 && !started; i++) {
    started = f.grandchildPid() > 1;
    if (!started) await delay(100);
  }
  assert.ok(started, "挂死插件应已派生孙进程");
  const before = Date.now();
  const stopped = await f.cli("stop");
  const elapsedMs = Date.now() - before;
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.ok(
    elapsedMs < 10_000,
    `stop 应整组杀掉目录子进程后立即返回，不再等 30 秒，实际 ${elapsedMs}ms`,
  );
  const record = readService(f.data);
  assert.ok(!record || !alive(record.pid), "服务应已停止");
  // 孙进程随进程组死亡，不留孤儿
  const orphan = f.grandchildPid();
  let aliveGrandchild = true;
  for (let i = 0; i < 30 && aliveGrandchild; i++)
    try {
      process.kill(orphan, 0);
      await delay(100);
    } catch {
      aliveGrandchild = false;
    }
  assert.ok(
    !aliveGrandchild,
    `孙进程 ${orphan} 应随进程组被杀（反向：去掉 detached/组杀会变孤儿）`,
  );
  await pending.catch(() => undefined);
});

test("目录失败的报错写明卡在哪、插件是什么，冷却期内第二个请求立即返回", async (t) => {
  const f = await serviceFixture(t);
  await f.cli("list"); // 重启服务（新进程，失败缓存清零）
  const startedAt = Date.now();
  const first = await fetch(`${f.base()}/providers`, { headers: f.headers() });
  const firstMs = Date.now() - startedAt;
  const text = await first.text();
  assert.equal(first.status, 400, text);
  assert.match(text, /供应商目录不可用/);
  assert.match(text, /卡在「加载插件」/);
  assert.match(text, /hang-pkg/, `报错应写明模板插件：${text}`);
  assert.ok(firstMs >= 20_000, `首个请求会等真实的挂死超时，实际 ${firstMs}ms`);
  const secondStart = Date.now();
  const second = await fetch(`${f.base()}/providers`, { headers: f.headers() });
  const secondMs = Date.now() - secondStart;
  const secondText = await second.text();
  assert.equal(second.status, 400, secondText);
  assert.match(secondText, /卡在「加载插件」/);
  assert.ok(
    secondMs < 2_000,
    `冷却期内第二个请求应立即复用结论，实际 ${secondMs}ms`,
  );
});
