import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "../server/service-state.ts";
import { canOpenBrowser, noBrowserHint } from "../server/service.ts";
import { trackFixture, untrackFixture } from "./fixture-signal.ts";

const exec = promisify(execFile);

/** 隔离夹具：随机端口、临时数据与模板；PATH 前置桩 open/xdg-open，被调用就写标记文件。 */
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = mkdtempSync(join(tmpdir(), "atrium-notty-"));
  const signal = trackFixture(join(root, "data"), root);
  const data = join(root, "data");
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const builtin = join(root, "pi-template");
  mkdirSync(builtin);
  writeFileSync(join(builtin, "settings.json"), '{"packages":[]}');
  writeFileSync(join(builtin, "SYSTEM.md"), "builtin rules");
  const bin = join(root, "stub-bin");
  mkdirSync(bin);
  const marker = join(root, "browser-opened");
  const stub = `#!/bin/sh\nprintf '%s' "$@" > "${marker}"\n`;
  for (const name of ["open", "xdg-open"]) {
    writeFileSync(join(bin, name), stub);
    chmodSync(join(bin, name), 0o755);
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    ATRIUM_DATA: data,
    ATRIUM_PORT: String(port),
    ATRIUM_DESKTOPS: join(root, "desktops"),
    ATRIUM_PI_HOME: join(root, ".pi"),
    ATRIUM_PI_TEMPLATE: builtin,
    PI_ACP_DIR: join(root, "acp"),
    PI_ACP_PI_COMMAND: join(root, "no-such-pi"),
  };
  const cli = async (...args: string[]) => {
    try {
      const output = await exec(
        process.execPath,
        [join(packageRoot, "bin/atrium.mjs"), ...args],
        { env, cwd: root, timeout: 30000 },
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
    rmSync(root, { recursive: true, force: true });
    untrackFixture(signal);
  });
  return { cli, marker };
}

function assertPrintedLoginLink(stdout: string) {
  assert.match(stdout, /非交互环境，没有打开浏览器/);
  assert.match(
    stdout,
    /登录链接：http:\/\/atrium\.localhost:\d+\/auth\/claim\//,
  );
}

test("canOpenBrowser：stdin 与 stdout 都是终端才放行", () => {
  assert.equal(canOpenBrowser({ isTTY: true }, { isTTY: true }), true);
  const notBoth: Array<[{ isTTY?: boolean }, { isTTY?: boolean }]> = [
    [{ isTTY: false }, { isTTY: true }],
    [{ isTTY: true }, { isTTY: false }],
    [{ isTTY: false }, { isTTY: false }],
    [{}, { isTTY: true }],
    [{ isTTY: true }, {}],
  ];
  for (const [stdin, stdout] of notBoth)
    assert.equal(canOpenBrowser(stdin, stdout), false);
  assert.match(
    noBrowserHint("http://atrium.localhost:1/auth/claim/x"),
    /非交互环境，没有打开浏览器；登录链接：/,
  );
});

test(
  "非交互命令不打开浏览器，打印登录链接；--print 与 --no-open 行为不变",
  { timeout: 90000 },
  async (t) => {
    const { cli, marker } = await fixture(t);
    // 无参数：不调用浏览器（桩标记不出现），输出登录链接与提示。
    const bare = await cli();
    assert.equal(bare.code, 0, bare.stderr);
    assertPrintedLoginLink(bare.stdout);
    assert.ok(
      !existsSync(marker),
      `openWeb 不应被调用（桩标记 ${marker} 不应出现）`,
    );
    // open：同样不调用浏览器，输出登录链接与提示。
    const open = await cli("open");
    assert.equal(open.code, 0, open.stderr);
    assertPrintedLoginLink(open.stdout);
    assert.ok(!existsSync(marker));
    // open --print：只输出链接本身，不带提示。
    const print = await cli("open", "--print");
    assert.equal(print.code, 0, print.stderr);
    assert.match(
      print.stdout.trim(),
      /^http:\/\/atrium\.localhost:\d+\/auth\/claim\//,
    );
    assert.doesNotMatch(print.stdout, /非交互环境/);
    assert.ok(!existsSync(marker));
    // --no-open：输出地址，不输出登录链接。
    const noOpen = await cli("--no-open");
    assert.equal(noOpen.code, 0, noOpen.stderr);
    assert.match(noOpen.stdout, /服务已就绪/);
    assert.doesNotMatch(noOpen.stdout, /登录链接/);
    assert.ok(!existsSync(marker));
  },
);
