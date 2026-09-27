import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { packageRoot } from "../server/service-state.ts";
import {
  assertNoFixtureLeaks,
  finishFixture,
  trackFixture,
} from "./fixture-signal.ts";
import { childEnv } from "./child-env.ts";
import { writeFakeBin } from "./fake-bin.ts";

const exec = promisify(execFile);
after(assertNoFixtureLeaks);

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
  for (const name of ["open", "xdg-open", "explorer"])
    writeFakeBin(join(bin, name), stub);
  const env: NodeJS.ProcessEnv = childEnv({
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    ATRIUM_DATA: data,
    ATRIUM_PORT: String(port),
    ATRIUM_DESKTOPS: join(root, "desktops"),
    ATRIUM_PI_HOME: join(root, ".pi"),
    ATRIUM_PI_TEMPLATE: builtin,
    PI_ACP_DIR: join(root, "acp"),
    PI_ACP_PI_COMMAND: join(root, "no-such-pi"),
  });
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
  t.after(() => finishFixture(signal));
  return { cli, marker };
}

test(
  "没有 Web：atrium 与 --no-open 都只输出地址、不调用浏览器；open 已不是命令",
  { timeout: 90000 },
  async (t) => {
    const { cli, marker } = await fixture(t);
    for (const args of [[], ["--no-open"]]) {
      const result = await cli(...args);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /服务已就绪/);
      assert.doesNotMatch(result.stdout, /登录链接|浏览器/);
      assert.ok(
        !existsSync(marker),
        `不应调用浏览器（桩标记 ${marker} 不应出现）`,
      );
    }
    const open = await cli("open");
    assert.notEqual(open.code, 0);
    assert.match(open.stderr, /不认识的命令：open/);
    assert.ok(!existsSync(marker));
  },
);
