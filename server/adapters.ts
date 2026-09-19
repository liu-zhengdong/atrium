import { Worker } from "node:worker_threads";
import { mkdirSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { IncomingHttpHeaders } from "node:http";
import type { Store } from "./store.ts";
import { Problem } from "./store.ts";

type Agent = ReturnType<Store["agent"]>;

export type AdapterMessage = {
  title?: unknown;
  body?: unknown;
  url?: unknown;
};

export type InboxResult = {
  stored: number;
  dropped: boolean;
  errors: string[];
};

const WORKER = new URL("./adapter-worker.mjs", import.meta.url);

export function adaptersDir(agent: Agent): string {
  return join(agent.cwd, "adapters");
}

export function listAdapters(agent: Agent): { dir: string; files: string[] } {
  const dir = adaptersDir(agent);
  let files: string[] = [];
  try {
    files = readdirSync(dir)
      .filter((f) => /\.(mjs|js)$/.test(f))
      .sort();
  } catch {
    files = [];
  }
  return { dir, files };
}

const GITHUB_TEMPLATE = `// GitHub 事件适配器：把推送过滤、整理后落入消息箱。
// 配合 gh webhook forward 使用：
//   gh webhook forward --repo <owner/repo> --events pull_request --url <接收地址>
// ctx.request 是完整请求（method / headers / query / body / rawBody）；
// ctx.emit({ title, body, url? }) 落一条消息；不 emit 即丢弃；
// 异常或超时（5 秒）时原文落入消息箱并记录一条系统通知。
export default async function (ctx) {
  if (ctx.request.headers["x-github-event"] !== "pull_request") return;
  const payload = ctx.request.body;
  const pr = payload?.pull_request;
  if (!pr) return;
  if (!["opened", "reopened", "synchronize", "closed"].includes(payload.action))
    return;
  ctx.emit({
    title: \`\${payload.repository.full_name} #\${pr.number} · \${pr.title}\`,
    body: JSON.stringify({
      event: \`pull_request.\${payload.action}\`,
      repository: payload.repository.full_name,
      number: pr.number,
      author: pr.user?.login,
      title: pr.title,
      external_content: true,
    }),
    url: pr.html_url ?? null,
  });
}
`;

/** 写入 GitHub 适配器模板；已存在同名文件时不覆盖。 */
export function writeGithubTemplate(agent: Agent): {
  dir: string;
  file: string;
} {
  const dir = adaptersDir(agent);
  const file = join(dir, "github.mjs");
  if (existsSync(file)) throw new Problem(409, "github.mjs 已存在，不会覆盖");
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, GITHUB_TEMPLATE, { mode: 0o600 });
  return { dir, file: "github.mjs" };
}

function runAdapters(
  payload: {
    dir: string;
    files: string[];
    request: unknown;
    agent: { id: string; ref: string; name: string; cwd: string };
  },
  timeoutMs: number,
): Promise<{
  emitted: { file: string; message: AdapterMessage }[];
  errors: string[];
  failed?: string;
}> {
  return new Promise((resolvePromise) => {
    const worker = new Worker(WORKER, { workerData: payload });
    const timer = setTimeout(() => {
      void worker.terminate();
      resolvePromise({
        emitted: [],
        errors: [],
        failed: `适配器执行超过 ${timeoutMs / 1000} 秒，已终止`,
      });
    }, timeoutMs);
    worker.once("message", (result) => {
      clearTimeout(timer);
      void worker.terminate();
      resolvePromise(result);
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      resolvePromise({
        emitted: [],
        errors: [],
        failed: `适配器执行失败：${error.message}`,
      });
    });
  });
}

function noticeBody(message: AdapterMessage): {
  title: string;
  body: string;
  url: string | null;
} {
  const rawTitle = String(message.title ?? "").trim();
  const rawBody = message.body;
  return {
    title: (rawTitle || "外部消息").slice(0, 200),
    body: (typeof rawBody === "string"
      ? rawBody
      : JSON.stringify(rawBody ?? null)
    ).slice(0, 20000),
    url:
      typeof message.url === "string" && message.url
        ? message.url.slice(0, 500)
        : null,
  };
}

/**
 * 统一接收口：推送交给该 Agent 的适配器处理；没有适配器时原文落入消息箱。
 * 适配器异常或超时时不丢消息：原文落箱并记录一条系统通知。
 */
export async function receiveInbox(
  store: Store,
  agent: Agent,
  input: {
    headers: IncomingHttpHeaders;
    query: unknown;
    body: unknown;
  },
  timeoutMs = 5000,
): Promise<InboxResult> {
  const bodyText = Buffer.isBuffer(input.body)
    ? input.body.toString("utf8")
    : typeof input.body === "string"
      ? input.body
      : JSON.stringify(input.body ?? null);
  let parsed: unknown = input.body;
  if (Buffer.isBuffer(input.body) || typeof input.body === "string") {
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      parsed = bodyText;
    }
  }
  const fallback = () =>
    store.addNotice(
      agent.id,
      "external",
      "外部推送",
      bodyText.slice(0, 20000) || "(空内容)",
    );
  const { files } = listAdapters(agent);
  if (!files.length) {
    fallback();
    return { stored: 1, dropped: false, errors: [] };
  }
  const request = {
    method: "POST",
    path: `/api/agents/${agent.id}/inbox`,
    headers: input.headers,
    query: input.query ?? {},
    body: parsed,
    rawBody: bodyText.slice(0, 20000),
  };
  const result = await runAdapters(
    {
      dir: adaptersDir(agent),
      files,
      request,
      agent: { id: agent.id, ref: agent.ref, name: agent.name, cwd: agent.cwd },
    },
    timeoutMs,
  );
  let stored = 0;
  for (const { file, message } of result.emitted) {
    const notice = noticeBody(message);
    store.addNotice(
      agent.id,
      `adapter:${file}`.slice(0, 50),
      notice.title,
      notice.body,
      null,
      notice.url,
    );
    stored += 1;
  }
  const errors = [...result.errors, ...(result.failed ? [result.failed] : [])];
  if (!stored && errors.length) {
    fallback();
    stored += 1;
  }
  for (const error of errors.slice(0, 3))
    store.addNotice(
      agent.id,
      "system",
      "适配器执行失败",
      String(error).slice(0, 2000),
    );
  return { stored, dropped: !stored, errors };
}
