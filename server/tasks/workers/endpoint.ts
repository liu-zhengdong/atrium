import { secretNameProblem } from "../../secrets/model.ts";
import {
  ENDPOINT_APIS,
  endpointProblem,
  type Adapter,
  type EndpointApi,
  type LaunchEndpoint,
} from "../adapters/types.ts";
import { ADAPTERS } from "../adapters/index.ts";
import type { FrontValue } from "./frontmatter.ts";
import type { ResolvedWorker } from "./profiles.ts";

/**
 * 自定义模型端点（t271）：执行者档案（任一层，常写在 models/<模型>）可写
 * `endpoint`（地址）、`endpoint_api`（openai / responses / anthropic，缺省 openai）、`endpoint_key`（凭据名）。
 * 密钥不写进档案：派活那一刻按凭据名在任务归属部门的节点链上找（与 `task add --secret` 同一套），
 * 注入成工具要的环境变量。这里只放纯函数：规则校验、取端点、算交给适配器的端点与要注入的密钥。
 */

export const ENDPOINT_KEYS = ["endpoint", "endpoint_api", "endpoint_key"];

export type Endpoint = { base_url: string; api: EndpointApi; key?: string };

/** 一条端点规则的毛病；没毛病返回 null（profiles.ts 解析档案时逐条查）。 */
export function endpointRuleProblem(
  key: string,
  value: FrontValue,
): string | null {
  if (key === "endpoint") {
    if (typeof value !== "string")
      return "endpoint 须是地址，如 http://llm.corp/v1";
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return `endpoint 不是合法地址：${value}`;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return "endpoint 只能是 http 或 https 地址";
    if (url.username || url.password || url.search)
      return "endpoint 里不要带用户名、密码或查询参数；密钥写成凭据，用 endpoint_key 引用";
    return null;
  }
  if (key === "endpoint_api")
    return (ENDPOINT_APIS as readonly FrontValue[]).includes(value)
      ? null
      : `endpoint_api 只能是 ${ENDPOINT_APIS.join("、")}`;
  if (key === "endpoint_key") {
    const problem =
      typeof value === "string" ? secretNameProblem(value) : "须是凭据名";
    return problem ? `endpoint_key：${problem}` : null;
  }
  return null;
}

/** 生效档案里的端点；没写 endpoint 为 undefined（只写了 endpoint_api / endpoint_key 不算）。 */
export function endpointOf(
  rules: Record<string, FrontValue | undefined>,
): Endpoint | undefined {
  if (typeof rules.endpoint !== "string") return undefined;
  const api = (ENDPOINT_APIS as readonly unknown[]).includes(rules.endpoint_api)
    ? (rules.endpoint_api as EndpointApi)
    : "openai";
  return {
    base_url: rules.endpoint,
    api,
    ...(typeof rules.endpoint_key === "string"
      ? { key: rules.endpoint_key }
      : {}),
  };
}

/** 这个工具接不接得了档案里的端点：接不了返回原因（档案校验与派活前共用）。 */
export function endpointFit(
  adapter: Adapter,
  rules: Record<string, FrontValue | undefined>,
): string | null {
  const endpoint = endpointOf(rules);
  return endpoint ? endpointProblem(adapter, endpoint.api) : null;
}

/**
 * 派活时交给适配器的端点，与要注入的密钥：凭据名 key.name 的值放进环境变量 key.as
 * （工具有固定变量名的用它，如 claude 的 ANTHROPIC_AUTH_TOKEN；否则就用凭据名本身）。
 */
export function launchEndpoint(
  adapter: Adapter,
  endpoint: Endpoint,
): { launch: LaunchEndpoint; key?: { name: string; as: string } } {
  const as = endpoint.key && (adapter.endpoints?.keyEnv ?? endpoint.key);
  return {
    launch: {
      base_url: endpoint.base_url,
      api: endpoint.api,
      ...(as ? { keyEnv: as } : {}),
    },
    ...(endpoint.key && as ? { key: { name: endpoint.key, as } } : {}),
  };
}

/**
 * 这个执行者这次要注入的端点密钥：凭据名与放进哪个环境变量；没写 endpoint_key 为 undefined。
 * 只写了 endpoint_key 没写 endpoint 的（地址配在工具自己的配置里，如 Pi 的 models.json）照样按名注入同名变量。
 */
export function endpointKey(worker: ResolvedWorker) {
  const rules = worker.profile.rules;
  const endpoint = endpointOf(rules);
  if (endpoint) return launchEndpoint(ADAPTERS[worker.tool]!, endpoint).key;
  return typeof rules.endpoint_key === "string"
    ? { name: rules.endpoint_key, as: rules.endpoint_key }
    : undefined;
}
