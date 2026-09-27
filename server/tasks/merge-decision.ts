/** 合入故障只在冲突或本地检查失败时交回；第三次交回留给负责人处理。 */
export const MAX_MERGE_RETURNS = 2;

export function mergeFailure(count: number, reason: string) {
  const returns = count + 1;
  return {
    returns,
    blocked: returns > MAX_MERGE_RETURNS,
    reason,
  };
}
