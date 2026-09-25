import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.ts";
import { userTokenPath } from "../server/user-auth.ts";

const token = () => randomBytes(32).toString("hex");
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const bearer = (value: string) => `Bearer ${value}`;

test("runner rotation keeps old connection until new credential connects, then fences old even for existing sessions", async () => {
  const data = mkdtempSync(join(tmpdir(), "atrium-runner-auth-"));
  const { app, runnerAuth: auth } = await createApp({ data, runtime: false });
  const fenced: { runnerId: string; credentialIds: string[] }[] = [];
  auth.listenFencing((runnerId, credentialIds) =>
    fenced.push({ runnerId, credentialIds }),
  );
  try {
    const old = token();
    const { runnerId, credentialId } = auth.issue("local host", hash(old));
    assert.deepEqual(auth.authenticateRunner(bearer(old)), {
      runnerId,
      credentialId,
    });
    assert(auth.validRunnerCredential(runnerId, credentialId));
    const next = token();
    const candidate = auth.rotate(runnerId, hash(next));
    assert(
      auth.validRunnerCredential(runnerId, credentialId),
      "a pending replacement does not interrupt current work",
    );
    assert.deepEqual(auth.authenticateRunner(bearer(next)), {
      runnerId,
      credentialId: candidate.credentialId,
    });
    assert.deepEqual(fenced, [{ runnerId, credentialIds: [credentialId] }]);
    assert(!auth.validRunnerCredential(runnerId, credentialId));
    assert.throws(() => auth.authenticateRunner(bearer(old)), /认证失败/);
    assert(auth.validRunnerCredential(runnerId, candidate.credentialId));
    assert.equal(auth.validRunnerCredential(runnerId, "rc999999"), false);
    assert.equal(
      auth.validRunnerCredential(runnerId, `rc${"9".repeat(100)}`),
      false,
    );
    assert.throws(() => auth.authenticateRunner(bearer(token())), /认证失败/);
    assert.throws(() => auth.authenticateRunner(undefined), /认证失败/);
    auth.revoke(runnerId);
    assert.equal(
      auth.validRunnerCredential(runnerId, candidate.credentialId),
      false,
    );
    assert.throws(() => auth.authenticateRunner(bearer(next)), /认证失败/);
    assert.deepEqual(fenced[1], {
      runnerId,
      credentialIds: [candidate.credentialId],
    });
  } finally {
    await app.close();
    rmSync(data, { recursive: true, force: true });
  }
});

test("runner issuance requires user authorization; user, agent and runner tokens do not cross trust boundaries", async () => {
  const data = mkdtempSync(join(tmpdir(), "atrium-runner-route-"));
  const { app, store } = await createApp({ data, runtime: false });
  try {
    const user = readFileSync(userTokenPath(data), "utf8").trim();
    const runner = token();
    const { agent: agentInfo, token: agent } = store.createAgent(
      "worker",
      data,
    );
    const url = "/api/runners";
    const payload = { name: "host", tokenHash: hash(runner) };
    for (const authorization of [undefined, bearer(agent), bearer(runner)]) {
      const reply = await app.inject({
        method: "POST",
        url,
        headers: authorization ? { authorization } : {},
        payload,
      });
      assert.equal(reply.statusCode, 401);
    }
    const issued = await app.inject({
      method: "POST",
      url,
      headers: { authorization: bearer(user) },
      payload,
    });
    assert.equal(issued.statusCode, 200);
    const { runnerId, credentialId } = issued.json() as {
      runnerId: string;
      credentialId: string;
    };
    assert.match(runnerId, /^r\d+$/);
    assert.match(credentialId, /^rc\d+$/);
    assert(
      !issued.body.includes(runner),
      "the server returns IDs, never raw runner credentials",
    );
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url,
          headers: { authorization: bearer(runner) },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/overview",
          headers: { authorization: bearer(runner) },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/mcp/${agentInfo.id}`,
          headers: { authorization: bearer(runner) },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url,
          headers: { authorization: bearer(user) },
        })
      ).statusCode,
      200,
    );
  } finally {
    await app.close();
    rmSync(data, { recursive: true, force: true });
  }
});
