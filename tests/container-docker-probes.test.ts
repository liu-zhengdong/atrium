import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const optedIn = process.env.ATRIUM_TEST_DOCKER_PROBES === "1";
const imageReady =
  optedIn &&
  spawnSync("docker", ["image", "inspect", "atrium-agent:167-probe"], {
    stdio: "ignore",
    timeout: 5000,
  }).status === 0;

test(
  "独立 Docker 假身份 ACP 与 MCP 探针（默认跳过：CI 未构建镜像／可能没有 Docker）",
  {
    skip:
      !imageReady &&
      "需先构建 atrium-agent:167-probe 并设 ATRIUM_TEST_DOCKER_PROBES=1；不挂真实身份/账号",
    timeout: 30_000,
  },
  () => {
    const acp = execFileSync(
      process.execPath,
      ["scripts/probe-167-container.mjs"],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 25_000,
      },
    );
    assert.match(acp, /ACP_INIT_OK no model, no account, no live identity/);
    const bridge = execFileSync(
      process.execPath,
      ["--import", "tsx", "scripts/probe-167-bridge.mjs"],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 25_000,
      },
    );
    assert.match(
      bridge,
      /BRIDGE_OK host-only URL; good MCP 200; old-generation 403/,
    );
  },
);
