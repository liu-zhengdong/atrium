import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");
const script = join(root, "scripts/prepare-release.mjs");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
    const path = join(dir, item.name);
    if (item.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|js|mjs)$/.test(item.name) ? [path] : [];
  });
}

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
        if (!builtinModules.includes(name) && !dependencies[name])
          missing.add(`${file.slice(root.length + 1)}: ${name}`);
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
  const { "@earendil-works/pi-ai": _, ...broken } = dependencies;
  assert.match(
    missingRuntimeDependencies(broken).join("\n"),
    /server\/model\.ts: @earendil-works\/pi-ai/,
  );
});

test("发布摘要、版本与锁文件在同一发布步骤同步", () => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-release-"));
  const json = (name: string) =>
    JSON.parse(readFileSync(join(dir, name), "utf8"));
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        version: "0.1.4",
        dependencies: { "@liuser/pi-atrium": "github:liu-zhengdong/pi-atrium" },
      }),
    );
    const sha = "a".repeat(40);
    writeFileSync(
      join(dir, "package-lock.json"),
      JSON.stringify({
        version: "0.1.4",
        packages: {
          "": {
            version: "0.1.4",
            dependencies: {
              "@liuser/pi-atrium": "github:liu-zhengdong/pi-atrium",
            },
          },
          "node_modules/@liuser/pi-atrium": {
            resolved: `git+ssh://git@github.com/liu-zhengdong/pi-atrium.git#${sha}`,
          },
        },
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
    const pinned = `github:liu-zhengdong/pi-atrium#${sha}`;
    assert.equal(
      json("package.json").dependencies["@liuser/pi-atrium"],
      pinned,
    );
    assert.equal(
      json("package-lock.json").packages[""].dependencies["@liuser/pi-atrium"],
      pinned,
    );
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
    rmSync(dir, { recursive: true, force: true });
  }
});
