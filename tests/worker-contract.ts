import { startApp } from "./task-fixture.ts";

/**
 * 执行者契约（t271）：只靠档案接入一个工具，派一件没有仓库的活，等它结束。
 * 新工具照着跑：把 profile 换成它的 `harness/<名字>` 档案，script 换成模拟它输出的假命令
 * （或在 tweak 里把真命令放上 PATH），断言 status 与日志。不改代码、不重启服务：档案经接口写入即登记。
 */

type After = Parameters<typeof startApp>[0];

export type Contract = {
  /** 工具名，也是 harness 档案名与假命令名。 */
  name: string;
  /** harness/<name> 的档案原文（经 PUT /api/workers/profiles 写入，与 `atrium workers edit --file` 同一路径）。 */
  profile: string;
  /** 假命令的 sh 脚本正文；undefined 表示不放假命令（tweak 里自己放）。 */
  script?: string;
  /** 执行者标识；缺省就是工具名。 */
  worker?: string;
  /** 其余档案（如 models/<模型>），键为 `层/名`。 */
  extra?: Record<string, string>;
  tweak?: Parameters<typeof startApp>[1];
};

export async function runContract(t: After, contract: Contract) {
  const started = await startApp(t, (fx) => {
    if (contract.script !== undefined)
      fx.script(contract.name, contract.script);
    contract.tweak?.(fx);
  });
  const { app, call } = started;
  const put = async (ref: string, source: string) => {
    const response = await app.inject({
      method: "PUT",
      url: `/api/workers/profiles/${ref}`,
      headers: { host: "127.0.0.1" },
      payload: { source },
    });
    if (response.statusCode !== 200)
      throw new Error(`写档案 ${ref} 失败：${response.body}`);
  };
  await put(`harness/${contract.name}`, contract.profile);
  for (const [ref, source] of Object.entries(contract.extra ?? {}))
    await put(ref, source);
  const created = await call("POST", "/api/tasks", {
    title: `契约：${contract.name}`,
    brief: "按说明回一句话。",
    deliver: "none",
  });
  if (created.status !== 201)
    throw new Error(`建任务失败：${JSON.stringify(created.body)}`);
  const ref = created.body.ref as string;
  const run = await call("POST", `/api/tasks/${ref}/run`, {
    worker: contract.worker ?? contract.name,
  });
  return { ...started, ref, run };
}

export async function waitTask(
  call: Awaited<ReturnType<typeof startApp>>["call"],
  ref: string,
) {
  const waited = await call("GET", `/api/tasks/${ref}/wait?timeout=20`);
  return waited.body.task as {
    status: string;
    result?: string | null;
    events: { kind: string; detail?: string | null }[];
  };
}
