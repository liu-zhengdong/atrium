/** GitHub 检查结果的纯判定；API 调用留在 facts.ts。 */
import { ciFromChecks, type Ci } from "./gate-parse.ts";

export type Check = { name?: string; bucket?: string; link?: string };
export type Job = {
  id: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  steps?: readonly unknown[];
};
export type Annotation = {
  annotation_level?: string;
  message?: string;
  title?: string;
};
export type Observation = {
  check: Check;
  job?: Job;
  annotations?: readonly Annotation[];
};

const unavailableReason =
  /\b(?:job was not started|could not be started|spending limit|billing|payment(?:s)? (?:have )?failed|quota|queued? (?:too long|timeout)|waiting for (?:an? )?(?:available )?runner|no (?:hosted |available )?runners? available)\b|计费|付款|配额|排队|额度不足/i;

export function actionJob(link: string | undefined) {
  if (!link) return null;
  try {
    const url = new URL(link);
    const match =
      /^\/([\w.-]+)\/([\w.-]+)\/actions\/runs\/(\d+)\/job\/(\d+)$/.exec(
        url.pathname,
      );
    if (url.hostname !== "github.com" || !match) return null;
    return {
      repo: `${match[1]}/${match[2]}`,
      run: match[3]!,
      job: Number(match[4]),
    };
  } catch {
    return null;
  }
}

function annotationSummary(annotation: Annotation): string {
  const message = (annotation.message || annotation.title || "")
    .replace(/\s+/g, " ")
    .trim();
  return message.length > 220 ? `${message.slice(0, 217)}…` : message;
}

export const ciUnavailableReason = (detail?: string) =>
  `CI 未运行：${detail || "检查任务未开始"}，需人工处理或本地验证`;

export function classifyCi(
  checks: readonly Check[],
  observations: readonly Observation[],
): { ci: Ci | null; detail?: string } {
  const base = ciFromChecks(checks);
  if (base !== "failure") return { ci: base };
  const failing = checks.filter(
    (check) => check.bucket === "fail" || check.bucket === "cancel",
  );
  const unavailable: string[] = [];
  const failed: string[] = [];
  for (const check of failing) {
    const observed = observations.find((item) => item.check === check);
    const annotation = observed?.annotations?.find(
      (item) =>
        item.annotation_level === "failure" &&
        unavailableReason.test(`${item.title ?? ""} ${item.message ?? ""}`),
    );
    if (
      annotation ||
      (observed?.job &&
        (observed.job.steps?.length === 0 || observed.job.status === "queued"))
    ) {
      unavailable.push(
        annotation
          ? annotationSummary(annotation)
          : `${check.name || observed?.job?.name || "检查"} job 未开始（${observed?.job?.steps?.length === 0 ? "零步骤" : "仍在队列"}）`,
      );
    } else failed.push(check.name || "未命名检查");
  }
  if (failed.length)
    return { ci: "failure", detail: `失败的检查：${failed.join("、")}` };
  return { ci: "unavailable", detail: unavailable[0] };
}
