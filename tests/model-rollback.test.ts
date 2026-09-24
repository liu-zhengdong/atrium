import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { modelLabel } from "../shared/model.ts";
import {
  restoreIdentityModel,
  snapshotIdentityModel,
  writeIdentityModel,
} from "../server/profile.ts";

test("模型标签使用目录原名和供应商显示名，缺元数据保留原 id", () => {
  const options = [
    {
      id: "anthropic/claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      providerName: "Anthropic",
    },
    {
      id: "kimi-coding/k3-256k",
      name: "Kimi K3 256K",
      providerName: "Kimi Coding",
    },
  ];
  assert.equal(
    modelLabel("anthropic/claude-sonnet-4-5:high", options),
    "Claude Sonnet 4.5 · Anthropic",
  );
  assert.equal(
    modelLabel("kimi-coding/k3-256k", options),
    "Kimi K3 256K · Kimi Coding",
  );
  assert.equal(modelLabel("deepseek/flash", options), "deepseek/flash");
});

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
