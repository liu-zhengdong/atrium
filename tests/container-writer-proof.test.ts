import { test } from "node:test";
import assert from "node:assert/strict";
import {
  containerWriterVerdict,
  mayReplaceContainerWriter,
  ownedContainerVerdict,
  type ContainerOwner,
  type DockerCommand,
} from "../server/container-writer-proof.ts";

const id = "a".repeat(64);
const inspect =
  (status: number | null, stdout = "", stderr = "") =>
  () => ({ status, stdout, stderr });

test("Docker 中只有已退出/不存在的旧实例允许新写者；未知不可放行", () => {
  assert.equal(
    containerWriterVerdict(
      id,
      inspect(0, '{"Running":true,"Status":"running"}'),
    ),
    "alive",
  );
  assert.equal(
    containerWriterVerdict(
      id,
      inspect(0, '{"Running":false,"Status":"exited"}'),
    ),
    "exited",
  );
  assert.equal(
    containerWriterVerdict(id, inspect(1, "", `Error: No such object: ${id}`)),
    "exited",
  );
  for (const bad of [
    inspect(null),
    inspect(2),
    inspect(0, "invalid"),
    inspect(0, '{"Running":false,"Status":"created"}'),
  ]) {
    assert.equal(containerWriterVerdict(id, bad), "unknown");
    assert.equal(mayReplaceContainerWriter(id, bad), false);
  }
  assert.equal(
    mayReplaceContainerWriter(
      undefined,
      inspect(0, '{"Running":false,"Status":"exited"}'),
    ),
    false,
  );
  assert.equal(
    mayReplaceContainerWriter(
      id,
      inspect(0, '{"Running":false,"Status":"exited"}'),
    ),
    true,
  );
  const previous = process.env.PATH;
  try {
    process.env.PATH = "/path/without/docker";
    assert.equal(containerWriterVerdict(id), "unknown");
    assert.equal(mayReplaceContainerWriter(id), false);
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
});

test("旧容器判定绑定 Docker 引擎、身份、代际和镜像，断开和错配不放行", () => {
  const owner: ContainerOwner = {
    containerId: id,
    engineId: "original-engine",
    imageId: `sha256:${"b".repeat(64)}`,
    identityId: "a1",
    generation: "generation-1",
  };
  const detail = (running: boolean, overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      state: { Running: running, Status: running ? "running" : "exited" },
      labels: {
        "atrium.identity": owner.identityId,
        "atrium.runner-generation": owner.generation,
        "atrium.image-id": owner.imageId,
      },
      image: owner.imageId,
      ...overrides,
    });
  const docker =
    (stdout: string, engine = owner.engineId): DockerCommand =>
    (args) =>
      args[0] === "info"
        ? { status: 0, stdout: engine, stderr: "" }
        : { status: 0, stdout, stderr: "" };
  assert.equal(ownedContainerVerdict(owner, docker(detail(true))), "alive");
  assert.equal(ownedContainerVerdict(owner, docker(detail(false))), "exited");
  assert.equal(
    ownedContainerVerdict(owner, docker(detail(false), "other-engine")),
    "unknown",
    "a different Docker engine is not proof of exit",
  );
  const missing: DockerCommand = (args) =>
    args[0] === "info"
      ? { status: 0, stdout: owner.engineId, stderr: "" }
      : { status: 1, stdout: "", stderr: `Error: No such object: ${id}` };
  assert.equal(ownedContainerVerdict(owner, missing), "exited");
  for (const bad of [
    { labels: {} },
    { labels: { "atrium.identity": "a2" } },
    { image: `sha256:${"c".repeat(64)}` },
    { state: { Running: false, Status: "created" } },
  ])
    assert.equal(
      ownedContainerVerdict(owner, docker(detail(false, bad))),
      "unknown",
    );
  assert.equal(
    ownedContainerVerdict(owner, () => ({
      status: null,
      stdout: "",
      stderr: "",
      error: new Error("docker unavailable"),
    })),
    "unknown",
  );
});
