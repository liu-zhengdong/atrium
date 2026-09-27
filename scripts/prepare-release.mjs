#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const summary = process.argv.slice(2).join(" ").trim();
if (!summary) throw new Error("发布摘要不能为空");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const releases = JSON.parse(readFileSync("releases.json", "utf8"));
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version);
if (!match) throw new Error(`不支持的版本号：${pkg.version}`);
const next = `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
if (releases[next]) throw new Error(`版本 v${next} 已存在`);
pkg.version = next;
lock.version = next;
lock.packages[""].version = next;
releases[next] = summary;
for (const [file, data] of [
  ["package.json", pkg],
  ["package-lock.json", lock],
  ["releases.json", releases],
]) {
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}
console.log(next);
