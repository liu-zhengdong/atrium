import { classifyRefreshError } from "./account-error.mjs";
import {
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

// This process owns the SDK and the provider plugin. Never send credentials over IPC.
const [directory, provider, operation] = process.argv.slice(2);
process.env.PI_CODING_AGENT_DIR = directory;
const send = (message) => process.send?.(message);
let session;
let failure = "未知错误";
try {
  const created = await createAgentSession({
    agentDir: directory,
    cwd: directory,
    sessionManager: SessionManager.inMemory(),
    noTools: "all",
  });
  session = created.session;
  if (created.extensionsResult.errors.length) {
    failure = "Provider 插件加载失败";
    throw new Error(failure);
  }
  if (operation === "refresh") {
    const result = await session.modelRuntime.getAuth(provider, {
      minOAuthValidityMs: 30 * 60 * 1000,
    });
    if (!result || "error" in result)
      throw result?.error ?? new Error("未知错误");
    send({ kind: "done" });
  } else {
    await session.modelRuntime.login(provider, "oauth", {
      notify: (event) => send({ kind: "notify", event }),
      prompt: (prompt) =>
        new Promise((resolve, reject) => {
          const id = Math.random().toString(36).slice(2);
          send({
            kind: "prompt",
            id,
            prompt: { ...prompt, signal: undefined },
          });
          const answer = (message) => {
            if (message?.id !== id) return;
            process.off("message", answer);
            if (typeof message.value === "string") resolve(message.value);
            else reject(new Error("登录已取消"));
          };
          process.on("message", answer);
        }),
    });
    send({ kind: "done" });
  }
} catch (error) {
  send({
    kind: "error",
    category:
      failure === "Provider 插件加载失败"
        ? failure
        : classifyRefreshError(error),
  });
  process.exitCode = 1;
} finally {
  session?.dispose();
}
