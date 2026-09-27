/**
 * 定时巡检防重入（t125）：上一轮没结束就跳过，慢一轮不叠一轮。
 */

export function skipIfBusy(fn: () => Promise<void>): () => Promise<void> {
  let busy = false;
  return async () => {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } finally {
      busy = false;
    }
  };
}
