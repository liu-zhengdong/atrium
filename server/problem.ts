/** 带 HTTP 状态码的失败；接口层直接转成响应，MCP 层转成工具错误。 */
export class Problem extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
