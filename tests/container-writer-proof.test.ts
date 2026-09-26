import { test } from "node:test";
import assert from "node:assert/strict";
import {
  containerWriterVerdict,
  mayReplaceContainerWriter,
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
