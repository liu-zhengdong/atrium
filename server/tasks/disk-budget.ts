import { stat } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { nodes, ref } from "../org/model.ts";
import { allShares } from "../org/share-store.ts";
import { ownAmount } from "../org/shares.ts";
import { all } from "./ledger-model.ts";
import { BudgetProblem } from "./budget-problem.ts";
import { runFile } from "../platform/index.ts";

const GB = 1024 ** 3;
type Worktree = { node_id: number; worktree: string };
export type SizeOf = (path: string) => Promise<number>;

async function defaultSize(path: string): Promise<number> {
  await stat(path);
  const { error, stdout } = await runFile("du", ["-sk", path], {
    timeout: 10_000,
    maxBuffer: 1024,
  });
  if (error) throw error;
  const gb = (Number.parseInt(stdout, 10) * 1024) / GB;
  if (!Number.isFinite(gb)) throw new Error("du 输出无效");
  return gb;
}

/** 章程里有没有磁盘份额；没有则巡检不起 du。 */
export function hasDiskShare(db: DatabaseSync): boolean {
  const table = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='org_budgets' LIMIT 1",
    )
    .get();
  if (!table) return false;
  return !!db
    .prepare("SELECT 1 FROM org_budgets WHERE dim='disk' LIMIT 1")
    .get();
}

/** du 结果仅保留一个巡检周期；路径必须来自账本已有任务的 worktree。 */
export class DiskBudget {
  private cache = new Map<string, { at: number; gb: number }>();
  private cursor = 0;
  constructor(
    private readonly db: DatabaseSync,
    private readonly sizeOf: SizeOf = defaultSize,
  ) {}

  private async size(path: string): Promise<number> {
    const cached = this.cache.get(path);
    if (cached && Date.now() - cached.at < 30_000) return cached.gb;
    try {
      const gb = await this.sizeOf(path);
      this.cache.set(path, { at: Date.now(), gb });
      return gb;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
  }

  /** 没配磁盘份额不起 du；有份额时每轮只巡五个 worktree。 */
  async refresh() {
    if (!hasDiskShare(this.db)) {
      this.cursor = 0;
      this.cache.clear();
      return;
    }
    const rows = all<{ id: number; worktree: string }>(
      this.db,
      "SELECT id,worktree FROM tasks WHERE id>? AND worktree IS NOT NULL ORDER BY id LIMIT 5",
      this.cursor,
    );
    if (!rows.length) {
      this.cursor = 0;
      return;
    }
    this.cursor = rows.at(-1)!.id;
    await Promise.all(
      rows.map((row) => this.size(row.worktree).catch(() => 0)),
    );
  }

  /** 节点章程写了磁盘份额（budget.disk）时核对该节点子树 worktree 占用；本机磁盘可用量不设下限（09-28 删）。 */
  async check(nodeId: number | null) {
    if (nodeId === null) return;
    const list = nodes(this.db);
    const node = list.find((n) => n.id === nodeId);
    if (!node) return;
    const shares = allShares(this.db);
    const chain = [];
    let current = node;
    while (current) {
      if (ownAmount(shares.get(current.id) ?? [], "disk", "") !== undefined)
        chain.push(current);
      current = list.find((n) => n.id === current!.parent_id)!;
    }
    if (!chain.length) return;
    // 按 id 倒序分页累计，不因 worktree 多而拒绝派活；已结束任务的工作树由清理（worktree-cleanup.ts）收走。
    const usage = new Map<number, number>();
    for (let before = Number.MAX_SAFE_INTEGER; ;) {
      const page = all<Worktree & { id: number }>(
        this.db,
        "SELECT id,node_id,worktree FROM tasks WHERE id<? AND node_id IS NOT NULL AND worktree IS NOT NULL ORDER BY id DESC LIMIT 500",
        before,
      );
      for (const row of page)
        usage.set(
          row.node_id,
          (usage.get(row.node_id) ?? 0) + (await this.size(row.worktree)),
        );
      if (page.length < 500) break;
      before = page.at(-1)!.id;
    }
    for (const current of chain) {
      const limit = ownAmount(shares.get(current.id) ?? [], "disk", "");
      if (limit !== undefined) {
        const subtree = new Set([current.id]);
        for (const candidate of list) {
          let parent = candidate.parent_id;
          while (parent !== null) {
            if (parent === current.id) {
              subtree.add(candidate.id);
              break;
            }
            parent = list.find((n) => n.id === parent)?.parent_id ?? null;
          }
        }
        const used = [...usage].reduce(
          (sum, [id, gb]) => sum + (subtree.has(id) ? gb : 0),
          0,
        );
        if (used >= limit)
          throw new BudgetProblem(
            `${ref(current.id)} ${current.name} 的磁盘份额 ${limit} GB，worktree 已占约 ${used.toFixed(2)} GB；先清理该节点已结束任务的 worktree`,
          );
      }
    }
  }
}
