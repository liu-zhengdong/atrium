/**
 * #222：测试进程被 SIGINT/SIGTERM 打断时，fixture-signal 登记的中断收尾要把
 * 夹具拉起的后台服务、它的子进程和临时目录一起带走，
 * 退出码 130/143；不属于本次测试的服务不能误伤。
 * 反向对照：同一个受害者脚本不登记收尾时，同样的打断会留下服务——
 * 证明上面的断言确实由收尾逻辑承担。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { alive, packageRoot, readService } from "../server/service-state.ts";
import {
  descendantsOf,
  finishFixture,
  sweepTestRun,
  trackFixture,
} from "./fixture-signal.ts";
import { childEnv } from "./child-env.ts";
import { removeTemp } from "./temp-dir.ts";

const exec = promisify(execFile);
const victimScript = join(packageRoot, "tests", "fixtures", "signal-victim.ts");

// Windows 读不到别的进程的工作目录，按夹具目录找进程只在 Unix 上成立（同文件其余信号用例同样只跑 Unix）。
test(
  "服务启动途中尚无登记时，仍按夹具目录杀掉进程",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "atrium-early-service-"));
    const data = join(root, "data");
    mkdirSync(data);
    const fixture = trackFixture(data, root);
    t.after(() => finishFixture(fixture));
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        cwd: data,
        detached: true,
        stdio: "ignore",
      },
    );
    assert.ok(child.pid);
    await new Promise<void>((resolve) => child.once("spawn", resolve));
    await finishFixture(fixture);
    for (let i = 0; i < 20 && alive(child.pid); i++) await delay(50);
    assert.equal(alive(child.pid), false);
    assert.equal(existsSync(root), false);
  },
);

type VictimInfo = { root: string; pid: number; descendants: number[] };

function startVictim(cleanup: boolean, runId?: string) {
  const child = spawn(process.execPath, ["--import", "tsx", victimScript], {
    env: childEnv({
      VICTIM_NO_CLEANUP: cleanup ? "0" : "1",
      ...(runId ? { ATRIUM_TEST_RUN_ID: runId } : {}),
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += String(d)));
  let reported = false;
  const ready = new Promise<VictimInfo>((resolve, reject) => {
    let buffer = "";
    child.stdout.on("data", (d) => {
      buffer += String(d);
      const newline = buffer.indexOf("\n");
      if (newline >= 0 && !reported) {
        reported = true;
        resolve(JSON.parse(buffer.slice(0, newline)) as VictimInfo);
      }
    });
    child.on("exit", (code) => {
      if (!reported) reject(new Error(`受害者提前退出（${code}）：${stderr}`));
    });
  });
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );
  return { child, ready, exited, stderr: () => stderr };
}

test(
  "SIGKILL 测试子进程后，父启动器按本轮标记清理并判定遗留",
  { timeout: 240000, skip: process.platform === "win32" },
  async (t) => {
    const runId = randomUUID();
    const victim = startVictim(true, runId);
    const box: { info?: VictimInfo } = {};
    collectVictim(t, victim, box);
    const info = await victim.ready;
    box.info = info;
    victim.child.kill("SIGKILL");
    assert.equal((await victim.exited).signal, "SIGKILL");
    assert.deepEqual(sweepTestRun(runId), [info.root]);
    assert.equal(existsSync(info.root), false);
    // SIGKILL 只是发出信号，孤儿进程还要等系统回收，稍等再判。
    for (let i = 0; i < 50 && alive(info.pid); i++) await delay(20);
    assert.equal(alive(info.pid), false);
    assert.deepEqual(sweepTestRun(runId), []);
  },
);

/** 打断前另起一个不属于本次测试的服务（不同数据目录），用来验证不误伤。 */
async function startOutsider(t: { after: (fn: () => Promise<void>) => void }) {
  const root = mkdtempSync(join(tmpdir(), "atrium-outsider-"));
  const data = join(root, "data");
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const template = join(root, "pi-template");
  mkdirSync(template);
  writeFileSync(join(template, "settings.json"), '{"packages":[]}');
  writeFileSync(join(template, "SYSTEM.md"), "outsider rules");
  const env: NodeJS.ProcessEnv = childEnv({
    ATRIUM_DATA: data,
    ATRIUM_PORT: String(port),
    ATRIUM_DESKTOPS: join(root, "desktops"),
    ATRIUM_PI_HOME: join(root, ".pi"),
    ATRIUM_PI_TEMPLATE: template,
    PI_ACP_DIR: join(root, "acp"),
  });
  await exec(
    process.execPath,
    [join(packageRoot, "bin/atrium.mjs"), "task", "ls"],
    {
      env,
      cwd: root,
      timeout: 60000,
    },
  );
  const record = readService(data);
  assert.ok(record && alive(record.pid), "对照服务要活着");
  const pid = record.pid;
  t.after(async () => {
    await exec(
      process.execPath,
      [join(packageRoot, "bin/atrium.mjs"), "stop"],
      { env, cwd: root, timeout: 30000 },
    ).catch(() => {});
    if (alive(pid)) process.kill(pid, "SIGKILL");
    removeTemp(root);
  });
  return { root, pid };
}

/** 受害者收场兜底：断言失败中途离开时也不把进程树留在这个世界上。 */
function collectVictim(
  t: { after: (fn: () => Promise<void>) => void },
  victim: { child: ChildProcess },
  box: { info?: VictimInfo },
) {
  t.after(async () => {
    if (victim.child.exitCode === null && !victim.child.killed)
      victim.child.kill("SIGKILL");
    const info = box.info;
    if (!info) return;
    if (alive(info.pid)) {
      for (const pid of descendantsOf(info.pid))
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* 已死 */
        }
      try {
        process.kill(-info.pid, "SIGKILL");
      } catch {
        try {
          process.kill(info.pid, "SIGKILL");
        } catch {
          /* 已死 */
        }
      }
    }
    removeTemp(info.root);
  });
}

test(
  "SIGINT 打断：服务、子进程与临时目录收尾，退出码 130，不误伤别人的服务",
  { timeout: 240000, skip: process.platform === "win32" },
  async (t) => {
    const outsider = await startOutsider(t);
    const victim = startVictim(true);
    const box: { info?: VictimInfo } = {};
    collectVictim(t, victim, box);
    const info = await victim.ready;
    box.info = info;
    assert.ok(alive(info.pid), "打断前服务要活着");
    for (const pid of info.descendants) assert.ok(alive(pid));
    const tree = [info.pid, ...info.descendants];
    victim.child.kill("SIGINT");
    const { code } = await victim.exited;
    assert.equal(code, 130, "中断收尾后按 SIGINT 约定退出");
    // 收尾在退出前同步完成：进程一退出，整棵树和临时目录就该没了。
    for (let i = 0; i < 50 && tree.some((pid) => alive(pid)); i++)
      await delay(20);
    for (const pid of tree)
      assert.equal(alive(pid), false, `pid ${pid} 应随打断被收尾`);
    assert.equal(existsSync(info.root), false, "临时目录应随打断被删掉");
    assert.ok(alive(outsider.pid), "不属于本次测试的服务不能误伤");
  },
);

test(
  "SIGTERM 打断：服务、子进程与临时目录收尾，退出码 143",
  { timeout: 240000, skip: process.platform === "win32" },
  async (t) => {
    const victim = startVictim(true);
    const box: { info?: VictimInfo } = {};
    collectVictim(t, victim, box);
    const info = await victim.ready;
    box.info = info;
    const tree = [info.pid, ...info.descendants];
    victim.child.kill("SIGTERM");
    const { code } = await victim.exited;
    assert.equal(code, 143, "中断收尾后按 SIGTERM 约定退出");
    for (let i = 0; i < 50 && tree.some((pid) => alive(pid)); i++)
      await delay(20);
    for (const pid of tree)
      assert.equal(alive(pid), false, `pid ${pid} 应随打断被收尾`);
    assert.equal(existsSync(info.root), false, "临时目录应随打断被删掉");
  },
);

test(
  "反向对照：不登记中断收尾时，同样的 SIGINT 会泄漏服务与临时目录",
  { timeout: 240000, skip: process.platform === "win32" },
  async (t) => {
    const victim = startVictim(false);
    const box: { info?: VictimInfo } = {};
    collectVictim(t, victim, box);
    const info = await victim.ready;
    box.info = info;
    victim.child.kill("SIGINT");
    const { code, signal } = await victim.exited;
    assert.equal(code, null);
    assert.equal(signal, "SIGINT", "没有收尾登记时进程直接死于信号");
    assert.ok(alive(info.pid), "没有收尾登记时服务会留下来（泄漏复现）");
    assert.ok(existsSync(info.root), "没有收尾登记时临时目录会留下来");
    // 手动收拾残局，别把反向对照的泄漏留在机器上。
    for (const pid of descendantsOf(info.pid))
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* 已死 */
      }
    try {
      process.kill(-info.pid, "SIGKILL");
    } catch {
      process.kill(info.pid, "SIGKILL");
    }
    removeTemp(info.root);
  },
);
