import { classifyRefreshError } from "./account-error.mjs";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

// This process owns the SDK. Never send credentials over IPC.
// 供应商协议只用 Pi 自带实现：不加载账号目录或个人模板里的任何插件（#242）。
const [directory, provider, operation] = process.argv.slice(2);
process.env.PI_CODING_AGENT_DIR = directory;
const send = (message) => process.send?.(message);
let session;
try {
  const resourceLoader = new DefaultResourceLoader({
    agentDir: directory,
    cwd: directory,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const created = await createAgentSession({
    agentDir: directory,
    cwd: directory,
    sessionManager: SessionManager.inMemory(),
    noTools: "all",
    resourceLoader,
  });
  session = created.session;
  if (operation === "validate") {
    // 上下文已加载完，接下来是请求供应商阶段；超时归因要用（#223）。
    send({ kind: "phase", phase: "request" });
    const model = session.modelRuntime.getModels(provider)[0];
    if (!model) {
      send({
        kind: "validation",
        status: "skipped",
        reason: "此供应商没有可用模型，无法校验",
      });
    } else {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await session.modelRuntime.completeSimple(
          model,
          {
            messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
          },
          { maxTokens: 1, signal: controller.signal },
        );
        if (controller.signal.aborted || response.stopReason === "aborted")
          throw new Error("请求超时");
        if (response.stopReason === "error")
          throw new Error(response.errorMessage || "请求失败");
        send({ kind: "validation", status: "verified" });
      } catch (error) {
        const text = String(error?.message ?? error);
        const status =
          /\b(401|403)\b|unauthoriz|forbidden|invalid.api.key|invalid_key|authentication/i.test(
            text,
          )
            ? "rejected"
            : "unverified";
        // The response may echo the submitted key; the parent also redacts it.
        send({ kind: "validation", status, reason: text.slice(0, 600) });
      } finally {
        clearTimeout(timer);
      }
    }
    send({ kind: "done" });
  } else if (operation === "refresh") {
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
  send({ kind: "error", category: classifyRefreshError(error) });
  process.exitCode = 1;
} finally {
  session?.dispose();
}
