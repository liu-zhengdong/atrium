import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { noteOf } from "../choices/model.ts";
import { getChoice, type Choice, type Decided } from "../choices/store.ts";
import { Problem } from "../problem.ts";
import { localOffset, type Offset } from "../schedules/plan.ts";
import { oneLine } from "../text-width.ts";
import { SECRETARY } from "../leaders/route.ts";
import type { InboxEvent } from "../tasks/events/events.ts";
import {
  afterFailure,
  BIND_TTL_MS,
  bindMatch,
  cardKeyboard,
  cardText,
  CHAT_HELP,
  decidedCardText,
  messageText,
  noteReply,
  noteTarget,
  parseCallback,
  parseToken,
  proxyFor,
  proxyText,
  pushOf,
  quietText,
  scrub,
  sendAt,
  settingsPatch,
  sourceOf,
  togglePick,
  type CardChoice,
  type CardDraft,
  type Incoming,
  type Push,
} from "./model.ts";
import {
  cardByMessage,
  clearCards,
  deleteCard,
  drop,
  enqueue,
  ensureNotifyTables,
  getCard,
  lastOutcome,
  markFailed,
  markRetry,
  markSent,
  openCards,
  pending,
  pendingCount,
  prune,
  pruneCards,
  readNotifyFile,
  saveCard,
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
 * 攒满窗口、避开免打扰时段后合成一条发出去（选项单各自单发一张带按钮的卡片）；
 * 失败按上限重试，失败写服务日志（不含 token）。队列空时不挂定时器。
 * 绑定且打开时长轮询 getUpdates（不开入站端口，走同样的代理）：只认绑定的私聊，
 * 按钮点选、「拍板」「都不选」等同 atrium choice pick / pass，回复卡片的一句话记成拍板说明。判定在 model.ts。
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
  /** 在 Telegram 里拍板：等同 atrium choice pick / pass（拍板人 u1），由 app 接到选项单的拍板与知会。 */
  decide?: (ref: string, action: "pick" | "pass", body: object) => Decided;
  /** 单次长轮询最多等多久（秒），测试缩短。 */
  pollSeconds?: number;
};

/** 单次长轮询最多等多久（秒）。 */
const POLL_SECONDS = 25;
/** 收消息连续失败后的退避：5 秒起翻倍，封顶 5 分钟。 */
const LISTEN_RETRY_MS = 5_000;
const LISTEN_RETRY_MAX_MS = 5 * 60_000;
/** 同一个外来聊天多久记一次日志。 */
const FOREIGN_LOG_MS = 10 * 60_000;
export const BIND_WAIT_MAX = 240;

function telegramApi(value: string | undefined) {
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
  /** 常驻收消息的循环；没绑定、关着、在绑定时不跑。 */
  private listening: Promise<void> | null = null;
  private pollAbort: AbortController | null = null;
  /** 下一个要取的更新号（确认掉已处理的）。 */
  private updateOffset: number | undefined;
  private readonly foreignLogged = new Map<number | null, number>();
  private readonly pollSeconds: number;
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
    this.pollSeconds = options.pollSeconds ?? POLL_SECONDS;
  }

  /** 服务起来后接着发上次没发完的，并开始收按钮与回复。 */
  start() {
    this.schedule();
    this.listen();
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.abort.abort();
    this.pollAbort?.abort();
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
    if (event.kind === "choice_decided") {
      const ref = (event.detail as { choice?: unknown } | null)?.choice;
      // 在别处（命令行、网页、手机）拍了板：卡片改成已拍板、撤掉按钮。
      if (typeof ref === "string") void this.refreshCard(ref);
      return;
    }
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
        pruneCards(this.db, this.now());
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
    // 选项单各自一张带按钮的卡片；其余（和查不到的选项单）合成一条。
    const groups: { items: Queued[]; choice: Choice | null }[] = [];
    const rest: Queued[] = [];
    for (const item of batch) {
      const choice = item.kind === "choice" ? this.openChoice(item.ref) : null;
      if (choice) groups.push({ items: [item], choice });
      else rest.push(item);
    }
    if (rest.length) groups.unshift({ items: rest, choice: null });
    for (const [index, group] of groups.entries()) {
      try {
        await this.sendGroup(credential.chat_id!, credential.token, group);
        markSent(
          this.db,
          group.items.map((item) => item.id),
          this.now(),
        );
      } catch (error) {
        // 这一条和后面没发的一起按同一个结果重试或放弃。
        this.failed(
          error,
          credential.token,
          groups.slice(index).flatMap((g) => g.items),
        );
        return;
      }
    }
  }

  private async sendGroup(
    chat: number,
    token: string,
    group: { items: Queued[]; choice: Choice | null },
  ) {
    if (!group.choice) {
      await callTelegram(this.client(token), "sendMessage", {
        chat_id: chat,
        text: messageText(group.items),
        disable_web_page_preview: true,
      });
      return;
    }
    const choice = group.choice;
    const draft = this.draft(choice.ref);
    const sent = await callTelegram<{ message_id?: number }>(
      this.client(token),
      "sendMessage",
      {
        chat_id: chat,
        text: cardText(cardChoice(choice), draft),
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: cardKeyboard(cardChoice(choice), draft),
        },
      },
    );
    if (typeof sent?.message_id === "number")
      saveCard(
        this.db,
        choice.ref,
        { message_id: sent.message_id },
        this.now(),
      );
  }

  private failed(error: unknown, token: string, items: Queued[]) {
    const failure =
      error instanceof TelegramError
        ? error.failure
        : { status: null, message: scrub(String(error), token) };
    const message = scrub(failure.message, token);
    const ids = items.map((item) => item.id);
    const attempts = Math.max(...items.map((item) => item.attempts));
    const next = afterFailure(failure, attempts, this.now());
    if (next.kind === "retry") {
      markRetry(this.db, ids, next.attempts, next.at, message);
      this.log(
        `Telegram 推送失败（第 ${next.attempts} 次，${items.length} 件），${Math.round((next.at - this.now()) / 1000)} 秒后重试：${message}`,
      );
    } else {
      markFailed(this.db, ids, next.attempts, this.now(), message);
      this.log(
        `Telegram 推送失败（第 ${next.attempts} 次），放弃这 ${items.length} 件（${items.map((item) => item.ref).join("、")}）：${message}`,
      );
    }
  }

  /** 还开着的选项单；查不到、已拍板为 null。 */
  private openChoice(ref: string): Choice | null {
    const choice = this.findChoice(ref);
    return choice?.status === "open" ? choice : null;
  }

  private draft(ref: string): CardDraft {
    const card = getCard(this.db, ref);
    return { picks: card?.picks ?? [], note: card?.note ?? null };
  }

  /** 排队期间已经处理掉的：选项单拍过板了就不再推。 */
  private stale(item: Push) {
    if (item.kind !== "choice") return false;
    const row = this.db
      .prepare("SELECT status FROM choices WHERE id=?")
      .get(Number(item.ref.slice(1))) as { status: string } | undefined;
    return row !== undefined && row.status !== "open";
  }

  // ---- 收按钮与回复（长轮询 getUpdates） ----

  /** 绑定且打开时开始收；已在收、在绑定、关着都不动。 */
  private listen() {
    if (this.listening || this.closed || this.binding || !this.active()) return;
    const abort = new AbortController();
    this.pollAbort = abort;
    this.listening = this.receive(abort.signal)
      .catch((error: unknown) => {
        if (!this.closed)
          this.log(
            `Telegram 收消息出错：${scrub(String(error), this.file.credential?.token)}`,
          );
      })
      .finally(() => {
        if (this.pollAbort === abort) this.pollAbort = null;
        this.listening = null;
      });
  }

  private async stopListening() {
    this.pollAbort?.abort();
    await this.listening;
  }

  private async receive(signal: AbortSignal) {
    let backoff = LISTEN_RETRY_MS;
    while (!signal.aborted && !this.closed && this.active()) {
      const credential = this.file.credential!;
      let updates: Incoming[];
      try {
        updates = await callTelegram<Incoming[]>(
          {
            ...this.client(credential.token),
            timeoutMs: (this.pollSeconds + 15) * 1000,
            signal,
          },
          "getUpdates",
          {
            timeout: this.pollSeconds,
            allowed_updates: ["message", "callback_query"],
            ...(this.updateOffset !== undefined
              ? { offset: this.updateOffset }
              : {}),
          },
        );
        backoff = LISTEN_RETRY_MS;
      } catch (error) {
        if (signal.aborted || this.closed) return;
        const message =
          error instanceof TelegramError ? error.message : String(error);
        this.log(
          `Telegram 收消息失败，${Math.round(backoff / 1000)} 秒后重试：${scrub(message, credential.token)}`,
        );
        await sleep(backoff, undefined, { signal }).catch(() => undefined);
        backoff = Math.min(backoff * 2, LISTEN_RETRY_MAX_MS);
        continue;
      }
      for (const update of Array.isArray(updates) ? updates : []) {
        if (this.closed) return;
        if (typeof update?.update_id !== "number") continue;
        this.updateOffset = update.update_id + 1;
        try {
          await this.handle(update, credential.token, credential.chat_id!);
        } catch (error) {
          if (this.closed) return;
          this.log(
            `Telegram 处理收到的消息出错：${scrub(String(error), credential.token)}`,
          );
        }
      }
    }
  }

  private async handle(update: Incoming, token: string, chat: number) {
    const source = sourceOf(update, chat);
    if (source.kind === "skip") return;
    if (source.kind === "foreign") return this.foreign(source.chat);
    if (update.callback_query)
      return this.onButton(update.callback_query, token, chat);
    if (update.message) return this.onMessage(update.message, token, chat);
  }

  /** 别的聊天发来的：一律忽略，同一个聊天隔一阵才记一次日志（只记聊天号）。 */
  private foreign(chat: number | null) {
    const now = this.now();
    const last = this.foreignLogged.get(chat);
    if (last !== undefined && now - last < FOREIGN_LOG_MS) return;
    if (this.foreignLogged.size >= 100) this.foreignLogged.clear();
    this.foreignLogged.set(chat, now);
    this.log(
      `Telegram 收到未绑定的聊天（${chat ?? "未知"}）发来的操作，已忽略`,
    );
  }

  /** 卡片上的按钮：点选项（再点取消）、「拍板」、「都不选」；拍过板的一律回「已拍板」。 */
  private async onButton(
    query: NonNullable<Incoming["callback_query"]>,
    token: string,
    chat: number,
  ) {
    const answer = (text: string, alert = false) =>
      callTelegram(this.client(token), "answerCallbackQuery", {
        callback_query_id: query.id,
        text,
        ...(alert ? { show_alert: true } : {}),
      }).catch((error: unknown) => this.warn("回按钮", error, token));
    const action = parseCallback(query.data);
    if (!action || typeof query.id !== "string")
      return answer("这个按钮已失效");
    const choice = this.findChoice(action.choice);
    if (!choice) return answer(`找不到 ${action.choice}`);
    const message = query.message?.message_id;
    if (choice.status !== "open") {
      await this.finishCard(choice, token, chat, message);
      return answer("已拍板");
    }
    const draft = this.draft(choice.ref);
    if (action.kind === "toggle") {
      if (!choice.options.some((o) => o.seq === action.seq))
        return answer(`${choice.ref} 没有选项 ${action.seq}`);
      const picks = togglePick(draft.picks, action.seq);
      saveCard(
        this.db,
        choice.ref,
        {
          picks,
          ...(typeof message === "number" ? { message_id: message } : {}),
        },
        this.now(),
      );
      await this.editCard(choice, { ...draft, picks }, token, chat, message);
      return answer(
        picks.length ? `已选 ${picks.join("、")}，再点「拍板」` : "都没选",
      );
    }
    if (action.kind === "pick" && !draft.picks.length)
      return answer(
        "先点要做的选项，再点「拍板」；这轮都不要点「都不选」",
        true,
      );
    const body = {
      ...(action.kind === "pick" ? { picks: draft.picks } : {}),
      ...(draft.note ? { note: draft.note } : {}),
    };
    try {
      if (!this.options.decide) throw new Error("没接上选项单拍板");
      // 拍板后的知会（choice_decided）经 observe 把卡片改成结果、撤掉按钮。
      this.options.decide(choice.ref, action.kind, body);
    } catch (error) {
      if (error instanceof Problem && error.statusCode === 409) {
        const now = this.findChoice(choice.ref);
        if (now && now.status !== "open") {
          await this.finishCard(now, token, chat, message);
          return answer("已拍板");
        }
      }
      const reason = error instanceof Error ? error.message : String(error);
      return answer(`没拍成：${oneLine(reason, 150)}`, true);
    }
    return answer("已拍板");
  }

  /** 发来的文字：回复卡片（或只有一份等拍板时直接发）记成那份的拍板说明。 */
  private async onMessage(
    message: NonNullable<Incoming["message"]>,
    token: string,
    chat: number,
  ) {
    const say = (text: string) =>
      callTelegram(this.client(token), "sendMessage", {
        chat_id: chat,
        text,
        ...(typeof message.message_id === "number"
          ? { reply_to_message_id: message.message_id }
          : {}),
      }).catch((error: unknown) => this.warn("回消息", error, token));
    const text = typeof message.text === "string" ? message.text.trim() : "";
    if (!text || text.startsWith("/")) return say(CHAT_HELP);
    const replied = message.reply_to_message?.message_id;
    const target = noteTarget(
      typeof replied === "number"
        ? { card: cardByMessage(this.db, replied)?.choice ?? null }
        : null,
      openCards(this.db),
    );
    const refusal = noteReply(target);
    if (refusal || target.kind !== "choice") return say(refusal ?? CHAT_HELP);
    const choice = this.findChoice(target.choice);
    if (!choice || choice.status !== "open")
      return say(`${target.choice} 已拍板，这句说明没附上。`);
    let note: string | null;
    try {
      note = noteOf(text);
    } catch (error) {
      // 校验说明沿用命令行的（--note: …），手机上去掉参数名。
      const reason = error instanceof Error ? error.message : String(error);
      return say(reason.replace(/^--note:\s*/, ""));
    }
    const card = saveCard(this.db, choice.ref, { note }, this.now());
    await this.editCard(
      choice,
      card,
      token,
      chat,
      card.message_id ?? undefined,
    );
    return say(`已记下，拍板 ${choice.ref} 时附上这句说明。`);
  }

  /** 在别处（命令行、网页、手机）拍了板：卡片改成结果、撤掉按钮。 */
  private async refreshCard(ref: string) {
    const credential = this.file.credential;
    const choice = this.findChoice(ref);
    if (!credential || credential.chat_id === null || !choice) return;
    if (choice.status === "open") return;
    await this.finishCard(choice, credential.token, credential.chat_id);
  }

  /** 卡片改成已拍板的结果（没给消息号就用记下的那张），之后不再记这张卡片。 */
  private async finishCard(
    choice: Choice,
    token: string,
    chat: number,
    message?: number,
  ) {
    const card = getCard(this.db, choice.ref);
    const target = message ?? card?.message_id ?? undefined;
    // 先删再发：同一次拍板从按钮和知会两头进来只改一次。
    if (card) deleteCard(this.db, choice.ref);
    if (target === undefined) return;
    await this.edit(token, {
      chat_id: chat,
      message_id: target,
      text: decidedCardText(cardChoice(choice), choice.note),
      reply_markup: { inline_keyboard: [] },
    });
  }

  private editCard(
    choice: Choice,
    draft: CardDraft,
    token: string,
    chat: number,
    message: number | undefined,
  ) {
    if (message === undefined) return Promise.resolve();
    const card = cardChoice(choice);
    return this.edit(token, {
      chat_id: chat,
      message_id: message,
      text: cardText(card, draft),
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: cardKeyboard(card, draft) },
    });
  }

  /** 改消息；内容没变（重复点）不算错，其余记日志，不挡拍板。 */
  private async edit(token: string, body: Record<string, unknown>) {
    try {
      await callTelegram(this.client(token), "editMessageText", body);
    } catch (error) {
      if (error instanceof TelegramError && /not modified/i.test(error.message))
        return;
      this.warn("改卡片", error, token);
    }
  }

  private warn(what: string, error: unknown, token: string) {
    if (this.closed) return;
    const message = error instanceof Error ? error.message : String(error);
    this.log(`Telegram ${what}失败：${scrub(message, token)}`);
  }

  private findChoice(ref: string): Choice | null {
    try {
      return getChoice(this.db, ref);
    } catch {
      return null;
    }
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
    // 换了机器人：旧的收消息停掉，旧卡片作废。
    this.pollAbort?.abort();
    this.updateOffset = undefined;
    clearCards(this.db);
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
        "pbpaste | atrium notify --token",
      );
    if (this.binding)
      throw new Problem(409, "已经有一个绑定在等了", "conflict");
    // 同一个机器人同时只能有一处 getUpdates：先停掉常驻收消息，绑定完再接着收。
    this.binding = true;
    try {
      await this.stopListening();
      let bind = c.bind;
      if (!bind || bind.expires_at <= this.now()) {
        bind = { code: bindCode(), expires_at: this.now() + BIND_TTL_MS };
        this.save({ ...this.file, credential: { ...c, bind } });
      }
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
      this.listen();
    }
  }

  private async bound(chat: number, offset: number) {
    const c = this.file.credential!;
    const token = c.token;
    this.save({
      ...this.file,
      credential: { ...c, chat_id: chat, bind: null },
    });
    // 换了聊天：旧聊天里的卡片作废，已读的更新不再交给常驻收消息。
    if (c.chat_id !== chat) clearCards(this.db);
    this.updateOffset = offset;
    // 确认掉已读的更新；失败不影响绑定。
    await callTelegram(this.client(token), "getUpdates", {
      offset,
      timeout: 0,
    }).catch(() => undefined);
    await callTelegram(this.client(token), "sendMessage", {
      chat_id: chat,
      text: "已绑定 Atrium。之后「等你拍板」「上交到你这层的卡住／越界」「里程碑上线」会推到这里，只带标题和短号。",
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
    // 关掉时停收消息（按钮不再生效），打开时接着收；代理改了下一轮长轮询起生效。
    if (!this.active()) this.pollAbort?.abort();
    else this.listen();
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
        c ? "atrium notify --bind" : "pbpaste | atrium notify --token",
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
    this.pollAbort?.abort();
    this.updateOffset = undefined;
    clearCards(this.db);
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
        "pbpaste | atrium notify --token",
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

/** 卡片只用选项单的标题和选项标题，不带选项正文。 */
const cardChoice = (choice: Choice): CardChoice => ({
  ref: choice.ref,
  title: choice.title,
  status: choice.status,
  options: choice.options.map((o) => ({
    seq: o.seq,
    title: o.title,
    task: o.task,
  })),
});

const bindCode = () => randomBytes(5).toString("hex");

function bindHint(bot: string, code: string, expires_at: number) {
  return {
    code,
    link: bot ? `https://t.me/${bot}?start=${code}` : null,
    expires_at,
  };
}
