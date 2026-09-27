import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { serviceArgs, useDist } from "../server/entry.ts";
import {
  packageRoot,
  parseServiceRecord,
  readService,
} from "../server/service-state.ts";
import { childEnv } from "./child-env.ts";
import {
  assertNoFixtureLeaks,
  descendantsOf,
  finishFixture,
  trackFixture,
} from "./fixture-signal.ts";
import { removeTemp } from "./temp-dir.ts";

const exec = promisify(execFile);
after(assertNoFixtureLeaks);

test("入口规则：有 dist 且不在仓库里才用编译产物，ATRIUM_DIST=1 时仓库里也用", () => {
  const rows: [dist: boolean, git: boolean, forced: boolean, use: boolean][] = [
    [true, false, false, true],
    [true, false, true, true],
    [true, true, false, false],
    [true, true, true, true],
    [false, false, false, false],
    [false, false, true, false],
    [false, true, false, false],
    [false, true, true, false],
  ];
  for (const [dist, git, forced, use] of rows)
    assert.equal(
      useDist({ dist, git, forced }),
      use,
      `${dist} ${git} ${forced}`,
    );
});

test("拉起服务的参数：装好的包跑 dist/server.js；仓库里、没有 dist（回滚到旧版）或测试替换入口时用 tsx", (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-entry-"));
  const forced = process.env.ATRIUM_DIST;
  t.after(() => {
    removeTemp(root);
    if (forced === undefined) delete process.env.ATRIUM_DIST;
    else process.env.ATRIUM_DIST = forced;
  });
  delete process.env.ATRIUM_DIST;
  const tsx = (script: string) => [
    "--import",
    import.meta.resolve("tsx"),
    join(root, script),
  ];
  assert.deepEqual(serviceArgs(undefined, root), tsx("server/main.ts"));
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist", "server.js"), "");
  assert.deepEqual(serviceArgs(undefined, root), [
    join(root, "dist", "server.js"),
  ]);
  assert.deepEqual(
    serviceArgs("tests/fixtures/x.ts", root),
    tsx("tests/fixtures/x.ts"),
  );
  assert.deepEqual(serviceArgs("/abs/x.ts", root), [
    "--import",
    import.meta.resolve("tsx"),
    resolve(root, "/abs/x.ts"),
  ]);
  writeFileSync(join(root, ".git"), "gitdir: elsewhere\n");
  assert.deepEqual(serviceArgs(undefined, root), tsx("server/main.ts"));
  process.env.ATRIUM_DIST = "1";
  assert.deepEqual(serviceArgs(undefined, root), [
    join(root, "dist", "server.js"),
  ]);
});

test("服务登记记录校验：合格的只留四个字段，缺字段、类型或范围不对都拒绝", () => {
  const good = {
    instance: "0b6f3c1e-8f7a-4c2d-9e1b-5a6d7c8e9f01",
    pid: 1234,
    port: 4310,
    token: "a".repeat(64),
  };
  assert.deepEqual(parseServiceRecord({ ...good, extra: 1 }), good);
  const bad: unknown[] = [
    null,
    "x",
    {},
    { ...good, instance: "not-a-uuid" },
    { ...good, instance: 1 },
    { ...good, pid: 0 },
    { ...good, pid: 1.5 },
    { ...good, pid: "1" },
    { ...good, port: 0 },
    { ...good, port: 65536 },
    { ...good, token: "A".repeat(64) },
    { ...good, token: "a".repeat(63) },
    { ...good, token: undefined },
  ];
  for (const value of bad)
    assert.throws(
      () => parseServiceRecord(value),
      /服务登记记录格式不对/,
      JSON.stringify(value),
    );
});

/** 从入口顺着静态 import 走一遍，收集启动时就会加载的裸包名。 */
function startupPackages(dir: string, entry: string): Set<string> {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(join(dir, file), "utf8");
    for (const match of source.matchAll(
      /^(?:import|export)\s(?:[^;"]*?\sfrom\s*)?"([^"]+)";/gm,
    )) {
      const spec = match[1]!;
      if (spec.startsWith("./")) visit(spec.slice(2));
      else packages.add(spec);
    }
  };
  visit(entry);
  return packages;
}

test("编译产物：命令行启动不加载服务端重依赖，服务跑 dist/server.js、没有 tsx 与 esbuild 子进程", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-dist-"));
  const data = join(root, "data");
  const fixture = trackFixture(data, root);
  t.after(() => finishFixture(fixture));
  // 装好的包的样子：没有 .git，只有 bin、dist、网页静态文件与版本文件。
  cpSync(join(packageRoot, "bin"), join(root, "bin"), { recursive: true });
  for (const file of ["package.json", "releases.json"])
    cpSync(join(packageRoot, file), join(root, file));
  mkdirSync(dirname(join(root, "server/map/web")), { recursive: true });
  cpSync(join(packageRoot, "server/map/web"), join(root, "server/map/web"), {
    recursive: true,
  });
  symlinkSync(
    join(packageRoot, "node_modules"),
    join(root, "node_modules"),
    "junction",
  );
  execFileSync(
    process.execPath,
    [
      join(packageRoot, "scripts/build-dist.mjs"),
      "--outdir",
      join(root, "dist"),
    ],
    { stdio: "pipe" },
  );

  const dist = join(root, "dist");
  const loaded = startupPackages(dist, "cli.js");
  for (const heavy of ["zod", "yaml", "fastify", "node:http", "tsx"])
    assert.ok(!loaded.has(heavy), `命令行启动路径加载了 ${heavy}`);
  // 长跑的服务与 supervisor 不拆块：update 换掉磁盘上的包之后不会再去找旧块。
  for (const file of ["server.js", "supervisor.js"])
    assert.doesNotMatch(readFileSync(join(dist, file), "utf8"), /\.\/chunk-/);

  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const env = childEnv({
    ATRIUM_DATA: data,
    ATRIUM_PORT: String(port),
    ATRIUM_QUOTA_READERS: "off",
  });
  delete env.ATRIUM_DIST;
  const bin = join(root, "bin", "atrium.mjs");
  const cli = (...args: string[]) =>
    exec(process.execPath, [bin, ...args], { env, cwd: root, timeout: 30000 });

  const { stdout: which } = await exec(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { useDist } = await import(${JSON.stringify(pathToFileURL(join(root, "bin", "entry.mjs")).href)}); console.log(useDist("cli"), useDist("supervisor"));`,
    ],
    { env },
  );
  assert.equal(which.trim(), "true true");
  assert.match((await cli("--help")).stdout, /atrium guide/);

  await cli("--no-open");
  const record = readService(data);
  assert.ok(record);
  fixture.pids.add(record.pid);
  if (process.platform !== "win32") {
    const command = (pid: number) => {
      try {
        return execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
          encoding: "utf8",
        }).trim();
      } catch {
        return ""; // 已退出
      }
    };
    const server = command(record.pid);
    assert.match(server, /dist\/server\.js/);
    assert.doesNotMatch(server, /tsx/);
    for (const pid of descendantsOf(record.pid))
      assert.doesNotMatch(command(pid), /esbuild/);
  }
  assert.match((await cli("status")).stdout, new RegExp(String(port)));
  await cli("task", "ls");
  await cli("stop");
});
