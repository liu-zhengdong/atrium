import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { localOffset, type Offset } from "../schedules/plan.ts";
import { SECRETARY } from "../leaders/route.ts";
import type { InboxEvent } from "../tasks/events.ts";
import {
  afterFailure,
  BIND_TTL_MS,
  bindMatch,
  messageText,
  parseToken,
  proxyFor,
  proxyText,
  pushOf,
  quietText,
  scrub,
  sendAt,
  settingsPatch,
  type Push,
} from "./model.ts";
import {
  drop,
  enqueue,
  ensureNotifyTables,
  lastOutcome,
  markFailed,
  markRetry,
  markSent,
  pending,
  pendingCount,
  prune,
  readNotifyFile,
  writeNotifyFile,
  type NotifyFile,
  type Queued,
} from "./store.ts";
import {
  callTelegram,
  TELEGRAM_API,
  TelegramError,
  type TelegramOptions,
} from "./telegram.ts";

/**
 * 推送到手机（Telegram）的运行时：事件一落库就判要不要推，要推的排进待发队列；
 * 攒满窗口、避开免打扰时段后合成一条发出去；失败按上限重试，失败写服务日志（不含 token）。
 * 队列空时不挂定时器，服务空闲不占 CPU。判定在 model.ts。
 */

export type NotifierOptions = {
  data: string;
  /** Telegram 接口地址；测试给本地假服务器，缺省 ATRIUM_TELEGRAM_API 或官方地址。 */
  api?: string;
  /** 取系统代理的环境；缺省服务自己的环境（已按白名单放行 HTTPS_PROXY 等）。 */
  env?: Record<string, string | undefined>;
  now?: () => number;
  offset?: Offset;
  /** 单次请求超时（毫秒），测试缩短。 */
  timeoutMs?: number;
  /** 写服务日志；测试收集。 */
  log?: (line: string) => void;
};

/** 绑定时单次长轮询最多等多久（秒）。 */
const POLL_SECONDS = 25;
export const BIND_WAIT_MAX = 240;

export function telegramApi(value: string | undefined) {
  const api = value?.trim() || TELEGRAM_API;
  try {
    const url = new URL(api);
    if (url.protocol === "https:" || url.protocol === "http:")
      return api.replace(/\/+$/, "");
  } catch {
    // 落到下面的警告。
  }
  console.warn("ATRIUM_TELEGRAM_API 不是 http(s) 地址，改用官方地址");
  return TELEGRAM_API;
}

export class TelegramNotifier {
  private file: NotifyFile;
  private timer: NodeJS.Timeout | undefined;
  private timerAt = 0;
  private sending: Promise<void> | null = null;
  private binding = false;
  private closed = false;
  private readonly api: string;
  private readonly env: Record<string, string | undefined>;
  private readonly now: () => number;
  private readonly offset: Offset;
  private readonly log: (line: string) => void;
  private readonly abort = new AbortController();

  constructor(
    private readonly db: DatabaseSync,
    private readonly options: NotifierOptions,
  ) {
    ensureNotifyTables(db);
    this.file = readNotifyFile(options.data);
    this.api = telegramApi(options.api ?? process.env.ATRIUM_TELEGRAM_API);
    this.env = options.env ?? process.env;
    this.now = options.now ?? Date.now;
    this.offset = options.offset ?? localOffset;
    this.log = options.log ?? ((line) => console.warn(line));
  }

  /** 服务起来后接着发上次没发完的。 */
  start() {
    this.schedule();
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.abort.abort();
  }

  /** 发送是否打开：配了 token、绑了 chat、没关。 */
  private active() {
    const c = this.file.credential;
    return !!c && c.chat_id !== null && this.file.settings.enabled;
  }

  private client(token: string): TelegramOptions {
    return {
      api: this.api,
      token,
      proxy: this.file.settings.proxy,
      env: this.env,
      timeoutMs: this.options.timeoutMs,
    };
  }

  /** 事件落库后调（EventInbox 的观察者）：要推的排进队列。出错只记日志，不挡事件投递。 */
  observe(event: InboxEvent) {
    if (event.subscriber !== SECRETARY || !this.active()) return;
    const push = pushOf(event, SECRETARY, (ref) => this.taskTitle(ref));
    if (!push) return;
    if (enqueue(this.db, push, this.now())) this.schedule();
  }

  /** 运行时自己要推的一条（如秘书没在听，t242）：发送没打开就不排；返回排进去没有。 */
  push(push: Push) {
    if (!this.active()) return false;
    if (!enqueue(this.db, push, this.now())) return false;
    this.schedule();
    return true;
  }

  private taskTitle(ref: string) {
    const row = this.db
      .prepare("SELECT title FROM tasks WHERE id=?")
      .get(Number(ref.slice(1))) as { title: string } | undefined;
    return row?.title ?? null;
  }

  /** 按队首算下次发送时刻，挂一个定时器；队列空就不挂。 */
  private schedule() {
    if (this.closed || this.sending) return;
    const first = pending(this.db, 1)[0];
    if (!first || !this.active()) {
      clearTimeout(this.timer);
      this.timer = undefined;
      return;
    }
    const at = sendAt({
      oldest: first.created_at,
      batchMs: this.file.settings.batch_seconds * 1000,
      quiet: this.file.settings.quiet,
      offset: this.offset,
      retryAt: first.retry_at,
    });
    if (this.timer && this.timerAt === at) return;
    clearTimeout(this.timer);
    this.timerAt = at;
    // setTimeout 最多约 24.8 天；超过的分段等。
    const delay = Math.min(Math.max(0, at - this.now()), 2 ** 31 - 1);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, delay);
    this.timer.unref?.();
  }

  /** 发一批：到点才发（免打扰、攒批、重试时刻都已算进 schedule）。测试可直接调。 */
  flush(): Promise<void> {
    if (this.sending) return this.sending;
    this.sending = this.sendBatch()
      .catch((error: unknown) => {
        if (!this.closed)
          this.log(
            `Telegram 推送出错：${scrub(String(error), this.file.credential?.token)}`,
          );
      })
      .finally(() => {
        this.sending = null;
        // 服务在关：库已关，不再动它。
        if (this.closed) return;
        prune(this.db, this.now());
        this.schedule();
      });
    return this.sending;
  }

  private async sendBatch() {
    const credential = this.file.credential;
    if (!this.active() || !credential) return;
    const items = pending(this.db, 100);
    const stale = new Set(items.filter((item) => this.stale(item)));
    drop(
      this.db,
      [...stale].map((item) => item.id),
    );
    const batch = items.filter((item) => !stale.has(item));
    if (!batch.length) return;
    const first = batch[0]!;
    const now = this.now();
    if (
      sendAt({
        oldest: first.created_at,
        batchMs: this.file.settings.batch_seconds * 1000,
        quiet: this.file.settings.quiet,
        offset: this.offset,
        retryAt: first.retry_at,
      }) > now
    )
      return;
    const ids = batch.map((item) => item.id);
    try {
      await callTelegram(this.client(credential.token), "sendMessage", {
        chat_id: credential.chat_id,
        text: messageText(batch),
        disable_web_page_preview: true,
      });
      markSent(this.db, ids, this.now());
    } catch (error) {
      const failure =
        error instanceof TelegramError
          ? error.failure
          : {
              status: null,
              message: scrub(String(error), credential.token),
            };
      const message = scrub(failure.message, credential.token);
      const next = afterFailure(failure, first.attempts, this.now());
      if (next.kind === "retry") {
        markRetry(this.db, ids, next.attempts, next.at, message);
        this.log(
          `Telegram 推送失败（第 ${next.attempts} 次，${batch.length} 件），${Math.round((next.at - this.now()) / 1000)} 秒后重试：${message}`,
        );
      } else {
        markFailed(this.db, ids, next.attempts, this.now(), message);
        this.log(
          `Telegram 推送失败（第 ${next.attempts} 次），放弃这 ${batch.length} 件（${batch.map((item) => item.ref).join("、")}）：${message}`,
        );
      }
    }
  }

  /** 排队期间已经处理掉的：选项单拍过板了就不再推。 */
  private stale(item: Push) {
    if (item.kind !== "choice") return false;
    const row = this.db
      .prepare("SELECT status FROM choices WHERE id=?")
      .get(Number(item.ref.slice(1))) as { status: string } | undefined;
    return row !== undefined && row.status !== "open";
  }

  // ---- 设置（atrium notify …） ----

  status() {
    const c = this.file.credential;
    const s = this.file.settings;
    const system = proxyFor(new URL(this.api), null, this.env);
    const last = lastOutcome(this.db);
    return {
      configured: !!c,
      bot: c?.bot ?? null,
      bound: !!c && c.chat_id !== null,
      enabled: s.enabled,
      quiet: quietText(s.quiet),
      batch_seconds: s.batch_seconds,
      proxy: proxyText(s.proxy),
      system_proxy: system ? proxyText(system.href.replace(/\/$/, "")) : null,
      pending: pendingCount(this.db),
      last_sent_at: last.sent_at,
      last_error: last.error,
      bind:
        c && c.chat_id === null && c.bind && c.bind.expires_at > this.now()
          ? bindHint(c.bot, c.bind.code, c.bind.expires_at)
          : null,
    };
  }

  private save(file: NotifyFile) {
    writeNotifyFile(this.options.data, file);
    this.file = file;
  }

  /** 存 bot token：先用它调 getMe 核对（顺便拿机器人用户名），再写凭据文件，发一个绑定码。 */
  async setToken(body: unknown) {
    const token = parseToken(
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as { token?: unknown }).token
        : undefined,
    );
    let me: { username?: string };
    try {
      me = await callTelegram<{ username?: string }>(
        this.client(token),
        "getMe",
        {},
      );
    } catch (error) {
      throw this.problem(error, token, "核对 bot token");
    }
    const bot = typeof me.username === "string" ? me.username : "";
    const bind = { code: bindCode(), expires_at: this.now() + BIND_TTL_MS };
    drop(
      this.db,
      pending(this.db, 1000).map((item) => item.id),
    );
    this.save({
      credential: { token, bot, chat_id: null, bind },
      settings: this.file.settings,
    });
    return { bot, ...bindHint(bot, bind.code, bind.expires_at) };
  }

  /**
   * 等用户给机器人发绑定码：长轮询 getUpdates，收到私聊里带绑定码的消息就记下这个 chat，
   * 回一条「已绑定」。超时返回 timed_out；绑定码过期就换一个新的。
   */
  async bind(timeoutSeconds: number) {
    const c = this.file.credential;
    if (!c)
      throw new Problem(
        409,
        "还没存 bot token",
        "conflict",
        undefined,
        "pbpaste | atrium notify token",
      );
    if (this.binding)
      throw new Problem(409, "已经有一个绑定在等了", "conflict");
    let bind = c.bind;
    if (!bind || bind.expires_at <= this.now()) {
      bind = { code: bindCode(), expires_at: this.now() + BIND_TTL_MS };
      this.save({ ...this.file, credential: { ...c, bind } });
    }
    this.binding = true;
    try {
      const deadline = this.now() + timeoutSeconds * 1000;
      let offset: number | undefined;
      while (!this.closed) {
        const left = Math.ceil((deadline - this.now()) / 1000);
        const poll = Math.max(0, Math.min(POLL_SECONDS, left));
        let updates: Update[];
        try {
          updates = await callTelegram<Update[]>(
            {
              ...this.client(c.token),
              timeoutMs: (poll + 15) * 1000,
              signal: this.abort.signal,
            },
            "getUpdates",
            {
              timeout: poll,
              allowed_updates: ["message"],
              ...(offset !== undefined ? { offset } : {}),
            },
          );
        } catch (error) {
          if (this.closed) break;
          throw this.problem(error, c.token, "收消息");
        }
        for (const update of updates) {
          offset = update.update_id + 1;
          const message = update.message;
          if (
            message?.chat?.type === "private" &&
            typeof message.text === "string" &&
            typeof message.chat.id === "number" &&
            bindMatch(message.text, bind.code)
          )
            return this.bound(message.chat.id, offset);
        }
        if (this.now() >= deadline || poll === 0) break;
      }
      return {
        bound: false,
        timed_out: true,
        bot: c.bot,
        /** 之前绑过的聊天照常收推送（这次是想换一个）。 */
        kept: c.chat_id !== null,
        // 服务重启：命令行带剩余时间续等。
        ...(this.closed ? { restarting: true } : {}),
        ...bindHint(c.bot, bind.code, bind.expires_at),
      };
    } finally {
      this.binding = false;
    }
  }

  private async bound(chat: number, offset: number) {
    const c = this.file.credential!;
    const token = c.token;
    this.save({
      ...this.file,
      credential: { ...c, chat_id: chat, bind: null },
    });
    // 确认掉已读的更新；失败不影响绑定。
    await callTelegram(this.client(token), "getUpdates", {
      offset,
      timeout: 0,
    }).catch(() => undefined);
    await callTelegram(this.client(token), "sendMessage", {
      chat_id: chat,
      text: "已绑定 Atrium。之后「等你拍板」「上交到你这层的卡住／越界」「里程碑上线」和紧急任务的上线、卡住、止损没做成会推到这里，只带标题和短号。",
    }).catch((error: unknown) =>
      this.log(
        `Telegram 绑定回执没发出去：${scrub(error instanceof Error ? error.message : String(error), token)}`,
      ),
    );
    return { bound: true, timed_out: false, bot: c.bot };
  }

  /** 改免打扰、攒批、代理、开关。关掉时清空待发的。 */
  set(body: unknown) {
    const patch = settingsPatch(body);
    const settings = { ...this.file.settings, ...patch };
    this.save({ ...this.file, settings });
    if (!settings.enabled)
      drop(
        this.db,
        pending(this.db, 1000).map((item) => item.id),
      );
    clearTimeout(this.timer);
    this.timer = undefined;
    this.schedule();
    return this.status();
  }

  /** 发一条测试消息，立即发、不攒批、不看免打扰。 */
  async test() {
    const c = this.file.credential;
    if (!c || c.chat_id === null)
      throw new Problem(
        409,
        c ? "还没绑定聊天" : "还没存 bot token",
        "conflict",
        undefined,
        c ? "atrium notify bind" : "pbpaste | atrium notify token",
      );
    try {
      await callTelegram(this.client(c.token), "sendMessage", {
        chat_id: c.chat_id,
        text: "Atrium 测试推送：收到这条说明推送通了。",
      });
    } catch (error) {
      throw this.problem(error, c.token, "发测试消息");
    }
    return { sent: true, bot: c.bot };
  }

  /** 删掉 bot token 与绑定（设置保留），待发的清空。 */
  remove() {
    const had = !!this.file.credential;
    this.save({ ...this.file, credential: null });
    drop(
      this.db,
      pending(this.db, 1000).map((item) => item.id),
    );
    clearTimeout(this.timer);
    this.timer = undefined;
    return { removed: had };
  }

  /** 接口失败转成给用户看的错误：token 抹掉，连不上时提示代理。 */
  private problem(error: unknown, token: string, what: string) {
    const failure =
      error instanceof TelegramError
        ? error.failure
        : { status: null, message: String(error) };
    const message = scrub(failure.message, token);
    if (failure.status === 401 || failure.status === 404)
      return new Problem(
        400,
        `${what}失败：Telegram 不认这个 bot token，到 @BotFather 核对后重存`,
        "usage",
        undefined,
        "pbpaste | atrium notify token",
      );
    if (failure.status === 409)
      return new Problem(
        409,
        `${what}失败：这个机器人设了 webhook 或别处也在收消息（${message}）；先在别处停掉再绑定`,
        "conflict",
      );
    if (failure.status === null)
      return new Problem(
        424,
        /代理(连不上|拒绝)/.test(message)
          ? `${what}失败：${message}；检查代理在不在跑，或 atrium notify set --proxy off 改走系统代理`
          : `${what}失败：${message}；国内要经代理，配 atrium notify set --proxy http://127.0.0.1:7890 或设 HTTPS_PROXY 后重启服务`,
        "telegram_unreachable",
      );
    // 424：错在 Telegram 那头，信息要给到用户（5xx 会被统一入口换成「服务处理失败」）。
    return new Problem(424, `${what}失败：${message}`, "telegram_failed");
  }

  /** 队列里的（测试看）。 */
  queued(): Queued[] {
    return pending(this.db, 1000);
  }
}

type Update = {
  update_id: number;
  message?: { text?: string; chat?: { id?: number; type?: string } };
};

const bindCode = () => randomBytes(5).toString("hex");

function bindHint(bot: string, code: string, expires_at: number) {
  return {
    code,
    link: bot ? `https://t.me/${bot}?start=${code}` : null,
    expires_at,
  };
}
