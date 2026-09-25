import { Problem } from "../server/problem.ts";
import type { Client } from "./service.ts";

type MigrationAgent = {
  id: string;
  ref: string;
  name: string;
  runner: { id: string } | null;
  runtime: { busy: boolean } | null;
  running: boolean;
};

/** A bounded, one-time handoff; a failed identity stays on its previous owner. */
export async function migrateRunner(
  client: Client,
  runnerId: string,
  timeoutSeconds: number,
  progress: (message: string) => void = console.log,
) {
  const snapshot = () => client.get<{ agents: MigrationAgent[] }>("/overview");
  const initial = await snapshot();
  const pending = new Map(
    initial.agents.filter((a) => !a.runner).map((a) => [a.id, a]),
  );
  const previouslyRunning = new Set(
    [...pending.values()]
      .filter((a) => a.runtime || a.running)
      .map((a) => a.id),
  );
  const migrated: string[] = [];
  const failed: string[] = [];
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastReport = 0;
  while (pending.size && Date.now() < deadline) {
    const { agents } = await snapshot();
    for (const original of [...pending.values()]) {
      const agent = agents.find((a) => a.id === original.id);
      if (!agent) {
        failed.push(`${original.ref}：身份不存在`);
        pending.delete(original.id);
        continue;
      }
      if (agent.runner) {
        if (agent.runner.id === runnerId) migrated.push(agent.ref);
        else failed.push(`${agent.ref}：已经由 ${agent.runner.id} 持有`);
        pending.delete(agent.id);
        continue;
      }
      if (agent.runtime?.busy) continue;
      try {
        await client.post(`/agents/${agent.id}/runner/prepare-migration`);
      } catch (error) {
        if (error instanceof Problem && error.statusCode === 409) {
          if (!error.message.includes("终端身份不由服务管理")) continue;
          failed.push(`${agent.ref}：终端身份不由服务管理，无法迁移`);
        } else failed.push(`${agent.ref}：${String(error)}`);
        pending.delete(agent.id);
        continue;
      }
      // A stopped Pi may still be exiting; the bind endpoint checks the live
      // process, not a stale overview cache. Its 409 is a reason to wait.
      try {
        await client.put(`/agents/${agent.id}/runner`, { runnerId });
      } catch (error) {
        if (error instanceof Problem && error.statusCode === 409) continue;
        failed.push(`${agent.ref}：${String(error)}`);
        pending.delete(agent.id);
        continue;
      }
      pending.delete(agent.id);
      if (previouslyRunning.has(agent.id)) {
        try {
          await client.post(`/agents/${agent.id}/start`);
        } catch (error) {
          failed.push(
            `${agent.ref} 已交接但启动失败：${String(error)}；请先核查运行器，再手动启动，不要让旧服务重开`,
          );
          continue;
        }
      }
      migrated.push(agent.ref);
      progress(`${agent.ref} ${agent.name} 已迁到 ${runnerId}`);
    }
    if (!pending.size) break;
    if (Date.now() - lastReport >= 2000) {
      progress(
        `仍在等待：${[...pending.values()].map((a) => `${a.ref} ${a.name}`).join("、")}（已等待 ${Math.round(timeoutSeconds - (deadline - Date.now()) / 1000)} 秒）`,
      );
      lastReport = Date.now();
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(2000, Math.max(0, deadline - Date.now()))),
    );
  }
  const skipped = [...pending.values()].map((a) => a.ref);
  progress(
    `交接结束：成功 ${migrated.length}；失败 ${failed.length}；到期跳过 ${skipped.length}`,
  );
  for (const reason of failed) progress(`失败：${reason}`);
  if (skipped.length)
    progress(
      `未迁身份 ${skipped.join("、")} 保持旧归属。可稍后运行 atrium runner migrate ${runnerId} --timeout ${timeoutSeconds} 重试，或继续由旧网关管理。`,
    );
  return { migrated, failed, skipped };
}
