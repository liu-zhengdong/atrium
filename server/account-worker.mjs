import { classifyRefreshError } from "./account-error.mjs";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { sep } from "node:path";
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
let failureDetail;
try {
  let resourceLoader;
  let registrations = [];
  if (operation === "list") {
    resourceLoader = new DefaultResourceLoader({
      agentDir: directory,
      cwd: directory,
    });
    await resourceLoader.reload();
    const runtime = resourceLoader.getExtensions().runtime;
    registrations = [
      ...runtime.pendingProviderRegistrations.map(
        ({ name, extensionPath }) => ({ id: name, extensionPath }),
      ),
      ...runtime.pendingNativeProviderRegistrations.map(
        ({ provider, extensionPath }) => ({ id: provider.id, extensionPath }),
      ),
    ];
  }
  const created = await createAgentSession({
    agentDir: directory,
    cwd: directory,
    sessionManager: SessionManager.inMemory(),
    noTools: "all",
    ...(resourceLoader ? { resourceLoader } : {}),
  });
  session = created.session;
  if (created.extensionsResult.errors.length) {
    failureDetail = created.extensionsResult.errors
      .map(({ path, error }) => `${path}: ${error}`)
      .join("；");
    if (operation === "list")
      send({
        kind: "warning",
        count: created.extensionsResult.errors.length,
        details: created.extensionsResult.errors.map(
          ({ path, error }) => `${path}: ${error}`,
        ),
      });
    else {
      failure = "Provider 插件加载失败";
      throw new Error(failure);
    }
  }
  if (operation === "list") {
    const roots = created.extensionsResult.extensions
      .filter((extension) => extension.sourceInfo.origin === "package")
      .map((extension) => ({
        path: extension.resolvedPath,
        baseDir: extension.sourceInfo.baseDir,
      }));
    const providers = session.modelRuntime.getProviders().map((item) => {
      const registration = registrations.find((entry) => entry.id === item.id);
      const root =
        registration &&
        roots.find(
          (entry) =>
            entry.path === registration.extensionPath ||
            registration.extensionPath.startsWith(entry.baseDir + sep),
        );
      const packagePath = root?.baseDir ?? null;
      return {
        id: item.id,
        name: item.name,
        methods: [
          item.auth.oauth && "oauth",
          item.auth.apiKey && "api_key",
        ].filter(Boolean),
        packagePath,
      };
    });
    send({ kind: "list", providers });
    send({ kind: "done" });
  } else if (operation === "validate") {
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
  send({
    kind: "error",
    category:
      failure === "Provider 插件加载失败"
        ? failure
        : classifyRefreshError(error),
    // 插件失败带上原始错误（#230）；请求阶段的报文不经过这里，不会带出凭据。
    detail: (failureDetail ?? String(error?.message ?? error)).slice(0, 600),
  });
  process.exitCode = 1;
} finally {
  session?.dispose();
}
