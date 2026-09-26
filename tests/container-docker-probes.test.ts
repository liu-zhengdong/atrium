import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RunnerJournal } from "../server/runner-process.ts";

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

test(
  "Docker 真实旧写者在 runner journal 中阻挡恢复，退出才放行",
  {
    skip: !imageReady && "需独立假镜像与 ATRIUM_TEST_DOCKER_PROBES=1",
    timeout: 30_000,
  },
  (t) => {
    const run = (args: string[]) =>
      execFileSync("docker", args, { encoding: "utf8", timeout: 5000 }).trim();
    const dir = mkdtempSync(join(tmpdir(), "atrium-container-journal-"));
    const file = join(dir, "journal.json");
    const agentId = randomUUID();
    const imageId = run([
      "image",
      "inspect",
      "atrium-agent:167-probe",
      "--format",
      "{{.Id}}",
    ]).trim();
    const engineId = run(["info", "--format", "{{.ID}}"]).trim();
    const first = new RunnerJournal(file, "generation-1");
    first.containerStarting(agentId, engineId, imageId);
    let containerId: string | undefined;
    t.after(() => {
      if (containerId)
        spawnSync("docker", ["rm", "-f", containerId], { timeout: 5000 });
      rmSync(dir, { recursive: true, force: true });
    });
    try {
      containerId = run([
        "create",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "16",
        "--memory",
        "128m",
        "--label",
        `atrium.identity=${agentId}`,
        "--label",
        "atrium.runner-generation=generation-1",
        "--label",
        `atrium.image-id=${imageId}`,
        "--entrypoint",
        "/bin/sh",
        "atrium-agent:167-probe",
        "-c",
        "sleep 25",
      ]);
      first.containerCreated(agentId, containerId);
      run(["start", containerId]);
      first.containerRunning(agentId);
    } finally {
      first.close();
    }
    const next = new RunnerJournal(file, "generation-2");
    try {
      assert.equal(next.verdict(agentId), "alive");
      assert.throws(
        () => next.containerStarting(agentId, engineId, imageId),
        /旧身份写者/,
      );
      run(["stop", "-t", "1", containerId!]);
      assert.equal(next.verdict(agentId), "exited");
      next.containerStarting(agentId, engineId, imageId);
    } finally {
      next.close();
    }
  },
);
