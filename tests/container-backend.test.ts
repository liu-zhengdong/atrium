import { test } from "node:test";
import assert from "node:assert/strict";
import { requireContainerImage } from "../server/container-backend.ts";
import { Problem } from "../server/problem.ts";

const image = `sha256:${"a".repeat(64)}`;
const unavailable = (f: () => unknown) =>
  assert.throws(
    f,
    (error: unknown) =>
      error instanceof Problem &&
      error.statusCode === 409 &&
      error.code === "container_unavailable",
  );

test("未指定镜像或 Docker 不在 PATH 时明确 409，不尝试启动宿主 Pi", () => {
  unavailable(() => requireContainerImage(""));
  unavailable(() => requireContainerImage("atrium-agent:latest"));
  unavailable(() =>
    requireContainerImage(image, () => ({ status: 1, stdout: "" })),
  );
  assert.equal(
    requireContainerImage(image, () => ({ status: 0, stdout: `${image}\n` })),
    image,
  );
  const previous = process.env.PATH;
  try {
    process.env.PATH = "/path/without/docker";
    unavailable(() => requireContainerImage(image));
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
});
