import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { removeTemp } from "./temp-dir.ts";

const root = join(import.meta.dirname, "..");
const script = join(root, "scripts/prepare-release.mjs");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
    const path = join(dir, item.name);
    if (item.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|js|mjs)$/.test(item.name) ? [path] : [];
  });
}

// 仓库里跑源码才用的开发依赖：装好的包走 dist/，不加载它们（t117）。
const SOURCE_ONLY: Record<string, string[]> = {
  "bin/entry.mjs": ["tsx"],
};

function missingRuntimeDependencies(dependencies: Record<string, string>) {
  const missing = new Set<string>();
  for (const dir of ["server", "cli", "shared", "bin"]) {
    for (const file of sourceFiles(join(root, dir))) {
      const source = readFileSync(file, "utf8");
      // Static imports/exports plus literal dynamic import/require in shipped code.
      for (const match of source.matchAll(
        /(?:\bfrom[ \t]+|^\s*import[ \t]+|\b(?:import|require)[ \t]*\([ \t]*)["']([@\w][^"'\s]*)["']/gm,
      )) {
        const spec = match[1];
        if (
          spec.startsWith(".") ||
          spec.startsWith("/") ||
          spec.startsWith("node:")
        )
          continue;
        const name = spec.startsWith("@")
          ? spec.split("/").slice(0, 2).join("/")
          : spec.split("/")[0];
        const rel = file.slice(root.length + 1).replaceAll("\\", "/");
        if (SOURCE_ONLY[rel]?.includes(name)) continue;
        if (!builtinModules.includes(name) && !dependencies[name])
          missing.add(`${rel}: ${name}`);
      }
    }
  }
  return [...missing].sort();
}

test("发布包内所有裸包 import 都在运行依赖中，缺少声明时失败", () => {
  const { dependencies } = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  );
  assert.deepEqual(missingRuntimeDependencies(dependencies), []);
  assert.equal(dependencies.tsx, undefined, "安装包不再需要运行时的 tsx");
  const { fastify: _, ...broken } = dependencies;
  assert.match(
    missingRuntimeDependencies(broken).join("\n"),
    /server[\\/]app\.ts: fastify/,
  );
});

test("发布摘要、版本与锁文件在同一发布步骤同步", () => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-release-"));
  const json = (name: string) =>
    JSON.parse(readFileSync(join(dir, name), "utf8"));
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ version: "0.1.4" }),
    );
    writeFileSync(
      join(dir, "package-lock.json"),
      JSON.stringify({
        version: "0.1.4",
        packages: { "": { version: "0.1.4" } },
      }),
    );
    writeFileSync(join(dir, "releases.json"), '{"0.1.4":"旧版摘要"}');
    const version = execFileSync(
      process.execPath,
      [script, "更新", "身份管理"],
      {
        cwd: dir,
        encoding: "utf8",
      },
    ).trim();
    assert.equal(version, "0.1.5");
    assert.equal(json("package.json").version, "0.1.5");
    assert.equal(json("package-lock.json").packages[""].version, "0.1.5");
    assert.equal(json("releases.json")["0.1.4"], "旧版摘要");
    assert.equal(json("releases.json")["0.1.5"], "更新 身份管理");
    assert.throws(
      () =>
        execFileSync(process.execPath, [script, ""], {
          cwd: dir,
          stdio: "pipe",
        }),
      /发布摘要不能为空/,
    );
    assert.equal(json("package.json").version, "0.1.5");
  } finally {
    removeTemp(dir);
  }
});

test("发版标签带编译产物：先推版本提交，再把 dist/ 提交到标签上，npm pack 沿用它", () => {
  const workflow = readFileSync(
    join(root, ".github/workflows/release.yml"),
    "utf8",
  );
  const order = [
    "npm run bench:cli",
    "git push origin HEAD:main",
    "git add -f dist",
    'git tag "v${VERSION}"',
    'git push origin "v${VERSION}"',
  ].map((step) => workflow.indexOf(step));
  assert.ok(
    order.every((at) => at >= 0),
    `发版步骤缺失：${order}`,
  );
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
  );
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.ok(pkg.files.includes("dist"));
  assert.match(pkg.scripts.prepack, /build-dist\.mjs --prepack/);
});

test("从标签打包（没有 node_modules）：--prepack 沿用已提交的 dist/，缺产物时失败，stdout 不输出", () => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-prepack-"));
  try {
    // 标签 clone 的样子：脚本在，esbuild 不在。
    mkdirSync(join(dir, "scripts"));
    const copy = join(dir, "scripts", "build-dist.mjs");
    writeFileSync(copy, readFileSync(join(root, "scripts/build-dist.mjs")));
    const run = () =>
      spawnSync(process.execPath, [copy, "--prepack"], {
        cwd: dir,
        encoding: "utf8",
      });
    const missing = run();
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /没有 esbuild/);
    mkdirSync(join(dir, "dist"));
    for (const name of ["cli", "server", "supervisor"])
      writeFileSync(join(dir, "dist", `${name}.js`), "");
    const kept = run();
    assert.equal(kept.status, 0);
    assert.match(kept.stderr, /沿用已编译/);
    // atrium update（含旧版本）解析 `npm pack --json` 的 stdout，prepack 不能往里写。
    assert.equal(kept.stdout, "");
    assert.equal(readFileSync(join(dir, "dist", "cli.js"), "utf8"), "");
  } finally {
    removeTemp(dir);
  }
});
