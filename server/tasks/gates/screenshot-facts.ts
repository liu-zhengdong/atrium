/** PR 正文中的图片链接与运行时 HEAD 结果。链接提取不发网络请求。 */
export type ScreenshotFact = { url: string; status?: number; error?: string };

export function screenshotUrls(body: string): string[] {
  const urls: string[] = [];
  const markdown =
    /!\[[^\]]*\]\(\s*(?:<([^>]+)>|(https:\/\/[^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/gi;
  for (const match of body.matchAll(markdown)) urls.push(match[1] ?? match[2]!);
  const attachments =
    /https:\/\/github\.com\/user-attachments\/assets\/[\w-]+/gi;
  for (const match of body.matchAll(attachments)) urls.push(match[0]);
  return [...new Set(urls)];
}

type Head = (
  url: string,
  init: RequestInit,
) => Promise<Pick<Response, "status" | "headers">>;

function publicUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !host.includes(".") ||
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
      host.includes(":")
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

/** 不转发凭据；逐跳核对 HTTPS 重定向，避免指向本机的附件链接。 */
export async function checkScreenshot(
  value: string,
  head: Head = fetch,
): Promise<ScreenshotFact> {
  let url = publicUrl(value);
  if (!url) return { url: value, error: "不是可检查的公网 HTTPS 链接" };
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      const response = await head(url.href, {
        method: "HEAD",
        redirect: "manual",
        credentials: "omit",
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        url = location ? publicUrl(new URL(location, url).href) : null;
        if (!url)
          return { url: value, error: "重定向缺失或指向非公网 HTTPS 链接" };
        continue;
      }
      return { url: value, status: response.status };
    }
    return { url: value, error: "重定向超过 5 次" };
  } catch (error) {
    return {
      url: value,
      error:
        error instanceof Error && error.name === "TimeoutError"
          ? "HEAD 请求超时"
          : "HEAD 请求失败",
    };
  }
}

export async function readScreenshots(
  body: string,
  head: Head = fetch,
): Promise<ScreenshotFact[]> {
  return Promise.all(
    screenshotUrls(body).map((url) => checkScreenshot(url, head)),
  );
}
