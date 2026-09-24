import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = join(import.meta.dirname, "../scripts/prepare-release.mjs");

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
