import {
  BRIDGE_VIA,
  LISTEN_EVERY_MS,
  LISTEN_TTL_SECONDS,
  REMIND_MS,
  bridgePrompt,
  inboxLines,
  parseBridgeRecord,
  planBatch,
  recordSent
} from "./chunk-VRVTQ3U3.js";
import {
  endpointGone
} from "./chunk-JQF35LTD.js";

// cli/secretary-bridge.ts
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// server/platform/endpoint.ts
import { connect } from "node:net";
var failure = (error) => {
  const code = error?.code;
  return {
    ok: false,
    gone: endpointGone(process.platform, code),
    message: error instanceof Error ? error.message : String(error)
  };
};
function postLines(path, lines, timeoutMs = 5e3) {
  return new Promise((resolve) => {
    let settled = false;
    let written = false;
    const socket = connect(path);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish(
        written ? { ok: true } : { ok: false, gone: false, message: "\u8FDE\u4F1A\u8BDD\u6536\u4EF6\u5730\u5740\u8D85\u65F6" }
      ),
      timeoutMs
    );
    socket.once(
      "error",
      (error) => finish(written ? { ok: true } : failure(error))
    );
    socket.once(
      "close",
      () => finish(
        written ? { ok: true } : { ok: false, gone: false, message: "\u4F1A\u8BDD\u6536\u4EF6\u5730\u5740\u63D0\u524D\u65AD\u5F00" }
      )
    );
    socket.once("connect", () => {
      socket.end(lines.map((line) => `${line}
`).join(""), () => {
        written = true;
      });
    });
    socket.once("finish", () => {
      written = true;
      setTimeout(() => finish({ ok: true }), 200).unref();
    });
  });
}
function probeEndpoint(path, timeoutMs = 3e3) {
  return new Promise((resolve) => {
    const socket = connect(path);
    const finish = (result) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, gone: false, message: "\u63A2\u6D4B\u8D85\u65F6" }),
      timeoutMs
    );
    socket.once("connect", () => finish({ ok: true }));
    socket.once("error", (error) => finish(failure(error)));
  });
}

// cli/secretary-bridge.ts
var SecretaryBridge = class {
  constructor(options) {
    this.options = options;
  }
  options;
  closed = false;
  abort = new AbortController();
  sent = /* @__PURE__ */ new Map();
  listenFailed = false;
  close() {
    this.closed = true;
    this.abort.abort();
  }
  /** 跑到会话没了、被别的会话接手或 close；返回退出原因。 */
  async run() {
    const log = this.options.log ?? (() => {
    });
    const now = this.options.now ?? Date.now;
    const post = this.options.post ?? postLines;
    const probe = this.options.probe ?? probeEndpoint;
    const remindMs = this.options.remindMs ?? REMIND_MS;
    await this.heartbeat();
    const timer = setInterval(
      () => void this.heartbeat(),
      this.options.listenEveryMs ?? LISTEN_EVERY_MS
    );
    try {
      while (!this.closed) {
        if (this.options.owner && !this.options.owner())
          return "\u53E6\u4E00\u4E2A\u79D8\u4E66\u4F1A\u8BDD\u7684 bridge \u5DF2\u63A5\u624B";
        const alive = await probe(this.options.endpoint);
        if (!alive.ok && alive.gone) return "\u4F1A\u8BDD\u5DF2\u5173\u95ED\uFF08\u6536\u4EF6\u5730\u5740\u4E0D\u5728\u4E86\uFF09";
        let events;
        try {
          events = await this.options.source.wait(
            this.options.waitSeconds ?? 60,
            this.abort.signal
          );
        } catch (error) {
          if (this.closed) break;
          log(`\u53D6\u4E8B\u4EF6\u5931\u8D25\uFF0C\u7A0D\u540E\u91CD\u8BD5\uFF1A${message(error)}`);
          await this.pause();
          continue;
        }
        if (this.closed) break;
        const batch = planBatch(this.sent, events, now(), remindMs);
        const all = [...batch.fresh, ...batch.remind];
        if (!all.length) continue;
        const result = await post(
          this.options.endpoint,
          inboxLines(this.options.token, bridgePrompt(batch, remindMs))
        );
        if (result.ok) {
          recordSent(this.sent, all, now());
          log(
            `\u9001\u5165 ${all.map((event) => `#${event.id}`).join(" ")}${batch.remind.length ? `\uFF08\u5176\u4E2D\u518D\u63D0\u9192 ${batch.remind.map((event) => `#${event.id}`).join(" ")}\uFF09` : ""}`
          );
          continue;
        }
        if (result.gone) return "\u4F1A\u8BDD\u5DF2\u5173\u95ED\uFF08\u6536\u4EF6\u5730\u5740\u4E0D\u5728\u4E86\uFF09";
        log(`\u9001\u5165\u4F1A\u8BDD\u5931\u8D25\uFF0C\u7A0D\u540E\u91CD\u8BD5\uFF1A${result.message}`);
        await this.pause();
      }
      return "\u5DF2\u505C\u6B62";
    } finally {
      clearInterval(timer);
      await this.options.source.listen({ stop: true }).catch(() => {
      });
    }
  }
  async heartbeat() {
    if (this.closed) return;
    try {
      await this.options.source.listen({
        via: BRIDGE_VIA,
        ttl_seconds: LISTEN_TTL_SECONDS
      });
      if (this.listenFailed) this.options.log?.("\u5DF2\u91CD\u65B0\u5411\u670D\u52A1\u62A5\u300C\u5728\u542C\u300D");
      this.listenFailed = false;
    } catch (error) {
      if (!this.listenFailed)
        this.options.log?.(`\u5411\u670D\u52A1\u62A5\u300C\u5728\u542C\u300D\u5931\u8D25\uFF1A${message(error)}`);
      this.listenFailed = true;
    }
  }
  async pause() {
    try {
      await delay(this.options.retryMs ?? 5e3, void 0, {
        signal: this.abort.signal
      });
    } catch {
    }
  }
};
var message = (error) => error instanceof Error ? error.message : String(error);
var bridgeFile = (data) => join(data, "secretary", "bridge.json");
var bridgeLog = (data) => join(data, "secretary", "bridge.log");
function readBridge(data) {
  try {
    return parseBridgeRecord(readFileSync(bridgeFile(data), "utf8"));
  } catch {
    return null;
  }
}
function writeBridge(data, record) {
  mkdirSync(join(data, "secretary"), { recursive: true, mode: 448 });
  writeFileSync(bridgeFile(data), JSON.stringify(record), { mode: 384 });
}
function releaseBridge(data, pid) {
  if (readBridge(data)?.pid === pid) rmSync(bridgeFile(data), { force: true });
}
function serviceSource(api, subscriber = "secretary") {
  return {
    wait: async (timeout, signal) => (await api.get(
      `/events/wait?${new URLSearchParams({ as: subscriber, timeout: String(timeout) })}`,
      void 0,
      signal
    )).events,
    listen: async (input) => {
      await api.post(`/events/listen?as=${subscriber}`, input);
    }
  };
}
export {
  SecretaryBridge,
  bridgeLog,
  readBridge,
  releaseBridge,
  serviceSource,
  writeBridge
};
