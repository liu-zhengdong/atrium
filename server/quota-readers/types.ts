/**
 * 自带额度读取器的公共类型（#352）。读取器读各工具本机已登录的凭据、调供应商用量接口，
 * 输出若干额度窗口；pace.ts 再把窗口折成与 `openquota pace --json` 同结构的一行。
 */

/** 一个额度窗口（会话、周、月、模型专属……）；只收百分比口径。 */
export type QuotaWindow = {
  id: string;
  label: string;
  /** 0–100。 */
  usedPercent: number;
  /** 重置时刻（毫秒）；供应商没给为 null。 */
  resetsAt: number | null;
  /** 窗口长度（秒）；0 表示不知道或不按固定周期。 */
  periodSeconds: number;
};

export type ReadOk = {
  ok: true;
  plan: string | null;
  windows: QuotaWindow[];
  /** 读到的时刻（毫秒）。 */
  refreshedAt: number;
  /**
   * 账号指纹（#358 第 2 步）：账号 id 的 sha256 前 16 位（credentials.ts accountKey），不可逆、不含令牌；
   * 多台主机读到同一指纹算同一个账号。认不出账号为 null。
   */
  account?: string | null;
};

/** 读不到：reason 是给人看的中文原因，不含凭据、响应正文或路径以外的细节。 */
export type ReadFailed = {
  ok: false;
  reason: string;
  /** 供应商让隔多久再来（毫秒时刻）；缓存按它推迟下次请求。 */
  retryAt?: number;
};

export type ReadResult = ReadOk | ReadFailed;

export type Platform = "darwin" | "linux" | "win32";

/** 读取器用到的外部依赖；测试全部换成假的。 */
export type ReaderDeps = {
  platform: Platform;
  home: string;
  env: Readonly<Record<string, string | undefined>>;
  /** 读文本文件；不存在返回 undefined，其余错误抛出。 */
  readFile(path: string): Promise<string | undefined>;
  /** 读 macOS 钥匙串的通用密码；没有该项返回 undefined。 */
  keychain(service: string, account: string): Promise<string | undefined>;
  fetch: typeof fetch;
  now(): number;
  /** 单个请求的超时（毫秒）。 */
  timeoutMs: number;
};

/** 凭据来源：文件或钥匙串。路径判定（paths.ts）只产出这个，不读。 */
export type CredentialSource =
  | { kind: "file"; path: string }
  | { kind: "keychain"; service: string; account: string };

export type Reader = {
  /** 与执行者适配器的 quotaProvider、openquota pace 的 providerId 是同一套键。 */
  provider: string;
  read(deps: ReaderDeps): Promise<ReadResult>;
};
