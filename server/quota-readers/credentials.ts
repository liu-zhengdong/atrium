import type { CredentialSource, ReaderDeps } from "./types.ts";

/** 凭据文件上限：超过的不是登录文件，不读进内存。 */
const MAX_CREDENTIAL_BYTES = 1024 * 1024;

export type Found<T> = { ok: true; value: T; source: CredentialSource };
export type Missing = {
  ok: false;
  /** 有来源存在但内容读不出或不可用。 */
  unreadable: boolean;
};

/** 来源的中文说法（进报错原因）：文件给路径，钥匙串给服务名；都不含凭据。 */
export function describeSource(source: CredentialSource): string {
  return source.kind === "file" ? source.path : `钥匙串「${source.service}」`;
}

async function readSource(
  source: CredentialSource,
  deps: ReaderDeps,
): Promise<string | undefined> {
  if (source.kind === "keychain")
    return deps.keychain(source.service, source.account);
  return deps.readFile(source.path);
}

/**
 * 按顺序找第一份可用凭据；parse 返回 undefined 表示这份不可用（换下一份）。
 * 只读，不改、不刷新对方凭据。
 */
export async function firstCredential<T>(
  sources: readonly CredentialSource[],
  deps: ReaderDeps,
  parse: (text: string) => T | undefined,
): Promise<Found<T> | Missing> {
  let unreadable = false;
  for (const source of sources) {
    let text: string | undefined;
    try {
      text = await readSource(source, deps);
    } catch {
      unreadable = true;
      continue;
    }
    if (text === undefined) continue;
    if (text.length > MAX_CREDENTIAL_BYTES) {
      unreadable = true;
      continue;
    }
    const value = parse(text);
    if (value === undefined) {
      unreadable = true;
      continue;
    }
    return { ok: true, value, source };
  }
  return { ok: false, unreadable };
}

/** JSON 或十六进制编码的 JSON（Claude Code、Codex 在钥匙串里有时存成十六进制）。 */
export function parseJsonDocument(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length % 2 || !/^[0-9a-f]+$/i.test(trimmed))
      return undefined;
    try {
      return JSON.parse(Buffer.from(trimmed, "hex").toString("utf8"));
    } catch {
      return undefined;
    }
  }
}

/** JWT 载荷里的 exp（毫秒）；不是 JWT 或没有 exp 为 undefined。只解码，不校验签名。 */
export function jwtExpiry(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const data: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    const exp =
      data && typeof data === "object"
        ? (data as Record<string, unknown>).exp
        : undefined;
    return typeof exp === "number" && Number.isFinite(exp)
      ? exp * 1000
      : undefined;
  } catch {
    return undefined;
  }
}
