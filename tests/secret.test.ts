import assert from "node:assert/strict";
import { test } from "node:test";
import { sameSecret } from "../shared/secret.ts";

test("secret comparisons accept any length and reject distinct tokens or digests", () => {
  const digest = "a".repeat(64);
  assert(sameSecret("", ""));
  assert(sameSecret(digest, digest));
  assert(!sameSecret("", digest));
  assert(!sameSecret("a", "ab"));
  assert(!sameSecret(digest, "b".repeat(64)));
  assert(!sameSecret("é", "e"));
});
