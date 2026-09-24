import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  restoreIdentityModel,
  snapshotIdentityModel,
  writeIdentityModel,
} from "../server/profile.ts";

test("模型切换失败仅回退模型字段，保留同时修改的其他配置", () => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-model-"));
  const file = join(dir, "settings.json");
  try {
    writeFileSync(
      file,
      JSON.stringify({
        packages: ["old"],
        defaultProvider: "anthropic",
        defaultModel: "original",
        defaultThinkingLevel: "high",
      }),
    );
    const before = snapshotIdentityModel(dir);
    writeIdentityModel(dir, {
      provider: "openai",
      model: "new",
      thinking: null,
    });
    const changed = JSON.parse(readFileSync(file, "utf8"));
    changed.packages = ["new"];
    writeFileSync(file, JSON.stringify(changed));
    restoreIdentityModel(dir, before);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
      packages: ["new"],
      defaultProvider: "anthropic",
      defaultModel: "original",
      defaultThinkingLevel: "high",
    });
    writeFileSync(file, JSON.stringify({ packages: [] }));
    const empty = snapshotIdentityModel(dir);
    writeIdentityModel(dir, {
      provider: "openai",
      model: "new",
      thinking: null,
    });
    restoreIdentityModel(dir, empty);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { packages: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
