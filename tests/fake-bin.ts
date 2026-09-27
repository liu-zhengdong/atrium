import {
  chmodSync,
  existsSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { findExecutable } from "../server/platform/index.ts";

/**
 * 测试里的假命令（假执行者、假 OpenQuota 等），三平台通用。
 *
 * Unix：原样写脚本并加可执行位。
 * Windows：无扩展名的脚本不能直接执行，另写一份 npm 风格的 `名字.cmd` 包装——
 * 平台层认得这种包装，会绕开 cmd.exe 直接用 node 跑目标（参数可带换行）：
 * `#!/usr/bin/env node` 脚本直接交给 node；`#!/bin/sh` 脚本经一个 node 转发脚本交给 Git 自带的 sh，
 * 输出由转发脚本接住再写出。
 * 返回调用方应当执行的路径（Windows 上是 .cmd）。
 */
export function writeFakeBin(file: string, content: string): string {
  writeFileSync(file, content);
  chmodSync(file, 0o755);
  if (process.platform !== "win32") return file;
  const dir = dirname(file);
  const name = file.slice(dir.length + 1);
  let target = name;
  if (!/^#!.*\bnode\b/.test(content)) {
    target = `${name}.sh.cjs`;
    // sh 的输出经管道由 node 转写：执行者日志在 Windows 上是「只追加」句柄，
    // MSYS 程序（Git 自带的 sh）直接写这种句柄会失败，node 写得进去。
    writeFileSync(
      join(dir, target),
      [
        'const { spawn } = require("node:child_process");',
        `const child = spawn(${JSON.stringify(gitSh())}, [${JSON.stringify(file)}, ...process.argv.slice(2)], { stdio: ["inherit", "pipe", "pipe"], windowsHide: true });`,
        'child.stdout.on("data", (chunk) => process.stdout.write(chunk));',
        'child.stderr.on("data", (chunk) => process.stderr.write(chunk));',
        'child.on("error", (error) => { console.error("fake-bin: " + error.message); process.exit(1); });',
        'child.on("close", (code) => process.exit(code ?? 1));',
        "",
      ].join("\n"),
    );
  }
  const shim = `${file}.cmd`;
  writeFileSync(
    shim,
    [
      "@ECHO off",
      "SETLOCAL",
      'SET "dp0=%~dp0"',
      'SET "_prog=node"',
      `"%_prog%" "%dp0%\\${target}" %*`,
      "",
    ].join("\r\n"),
  );
  return shim;
}

/** 删掉假命令（连同 Windows 上的包装与转发脚本），让它在 PATH 上找不到。 */
export function removeFakeBin(file: string) {
  for (const path of [file, `${file}.cmd`, `${file}.sh.cjs`])
    rmSync(path, { force: true });
}

/**
 * 只含假命令目录与系统基本命令的 PATH（让本机装的真 CLI 不被找到）；git 始终可用。
 * Unix：`bin:/usr/bin:/bin`，git 软链进 bin；Windows：bin、git 所在目录与 System32。
 */
export function isolatedPath(bin: string) {
  const git = findExecutable("git");
  if (!git) throw new Error("找不到 git");
  if (process.platform === "win32")
    return [
      bin,
      dirname(git),
      join(process.env.SystemRoot ?? "C:\\Windows", "System32"),
    ].join(";");
  if (!existsSync(join(bin, "git"))) symlinkSync(git, join(bin, "git"));
  return `${bin}:/usr/bin:/bin`;
}

let sh: string | undefined;

/** Git for Windows 自带的 sh：优先 Git\bin 下的启动器（会把 usr\bin 的 coreutils 加进 PATH）。 */
export function gitSh(): string {
  if (sh) return sh;
  const git = findExecutable("git");
  const candidates = [
    git && join(dirname(git), "..", "bin", "sh.exe"),
    git && join(dirname(git), "sh.exe"),
    "C:\\Program Files\\Git\\bin\\sh.exe",
    findExecutable("sh"),
  ];
  sh = candidates.find((path): path is string => !!path && existsSync(path));
  if (!sh) throw new Error("找不到 Git 自带的 sh.exe");
  return sh;
}
