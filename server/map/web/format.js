// 全景网页的纯文本助手：转义、把链接变可点、顶栏那一句怎么算。
// 不碰 DOM、不取数据，浏览器与测试（Node 直接导入）用同一份。

const ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
export const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);

/**
 * http(s) 链接：到空白或收尾的引号、反引号、中文标点为止。
 * 不认别的协议（javascript:、data: 等）——不认识的文本一律照常转义。
 */
const URL_PATTERN = /https?:\/\/[^\s<>"'`）】》，。；：！？]+/g;

/** 纯文本里的 http(s) 链接渲染成新标签页外链（rel=noopener），其余照常转义，不引入 XSS。 */
export function linkify(text) {
  const source = String(text ?? "");
  let html = "";
  let at = 0;
  for (const match of source.matchAll(URL_PATTERN)) {
    html += escapeHtml(source.slice(at, match.index));
    const href = escapeHtml(match[0]);
    html += `<a href="${href}" target="_blank" rel="noopener">${href}</a>`;
    at = match.index + match[0].length;
  }
  return html + escapeHtml(source.slice(at));
}

/**
 * 顶栏那一句：当前部分页显示本部分（含子部分）的在跑数；角色页、执行者页没有所属部分，
 * 显示全组织并写明「全组织」。没有在跑的任务就是「都停着」。
 */
export function liveText(page, data, now) {
  const local =
    page === "node" && data?.page === "node" && data.node?.counts
      ? data.node.counts.running
      : null;
  const running = local ?? now?.running ?? 0;
  if (!running) return "都停着";
  return local === null ? `全组织在做 ${running} 件` : `在做 ${running} 件`;
}
