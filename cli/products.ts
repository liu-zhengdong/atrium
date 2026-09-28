import type { ProductView } from "../server/products/model.ts";
import { recordNext } from "./contract.ts";
import { printJson, when } from "./format.ts";
import type { Command, Values } from "./main.ts";
import { everyWords } from "./schedules.ts";

/**
 * 产品部（atrium product add / ls）：设在任意节点下，管那一块的演进——定期调研、提选项单给用户拍板，
 * 不自己立项。一条命令建好部分、leader 与周期研究。
 */

const str = (values: Values, key: string) =>
  typeof values[key] === "string" ? (values[key] as string) : undefined;
const client = async () => (await import("./service.ts")).connect();

const STATE = { active: "", paused: "研究已暂停", removed: "研究已删除" };

export function productLine(p: ProductView) {
  return [
    `${p.node} ${p.name} · 管 ${p.parent_name}（${p.parent}）· leader ${p.leader}`,
    p.schedule
      ? `研究 ${p.schedule} ${p.every ? everyWords(p.every, null) : ""}${p.schedule_state === "active" && p.next_at !== null ? `，下次 ${when(p.next_at)}` : p.schedule_state ? `，${STATE[p.schedule_state]}` : ""}`
      : "没有周期研究",
    p.last_task ? `上一轮 ${p.last_task}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export const productCommands: Record<string, Command> = {
  "product add": {
    args: "节点 [--name 名称] [--every 7d] [--at 时刻] [--worker 工具+模型[:强度]]",
    about:
      "在节点下成立产品部（普通部分，管这一块的演进）：一条命令建好部分与人话字段、登记它的 leader、挂一个 research 周期任务（缺省每周）；每轮研究读这一块的全景、决定记录、巡检发现、失败与上线记录，可上网看同类产品，产出一份选项单等用户拍板，不写代码、不开 PR；--worker 同时定 leader 与研究用的执行者，不给时 leader 沿用上级 leader 的、研究按档案挑",
    options: {
      name: { type: "string" },
      every: { type: "string" },
      at: { type: "string" },
      worker: { type: "string" },
    },
    positionals: [1, 1],
    async run({ positionals: [node], values, json }) {
      const product = await (
        await client()
      ).post<ProductView>("/products", {
        node,
        ...Object.fromEntries(
          ["name", "every", "at", "worker"]
            .filter((key) => str(values, key) !== undefined)
            .map((key) => [key, str(values, key)]),
        ),
      });
      if (json) printJson(product);
      else
        console.log(
          `已在 ${product.parent_name}（${product.parent}）下成立产品部 ${product.node}：leader ${product.leader}，周期研究 ${product.schedule}${product.every ? ` ${everyWords(product.every, str(values, "at") ?? null)}` : ""}${product.next_at ? `，第一轮 ${when(product.next_at)}` : ""}；每轮产出一份选项单挂在 ${product.parent} 上等你拍板`,
        );
      recordNext(
        product.schedule
          ? `马上跑一轮：atrium schedule run ${product.schedule}`
          : `看产品部：atrium product ls`,
      );
    },
  },
  "product ls": {
    args: "[--node 节点]",
    about:
      "列出产品部：管哪一块、leader、周期研究的节奏与下一轮、上一轮任务；--node 只看设在这个节点下的",
    options: { node: { type: "string" } },
    positionals: [0, 0],
    async run({ values, json }) {
      const node = str(values, "node");
      const result = await (
        await client()
      ).get<{ products: ProductView[] }>(
        `/products${node ? `?node=${encodeURIComponent(node)}` : ""}`,
      );
      if (json) printJson(result);
      else
        console.log(
          result.products.map(productLine).join("\n") || "还没有产品部",
        );
      recordNext(
        result.products[0]
          ? `看它提的选项单：atrium choice ls --node ${result.products[0].parent}`
          : "成立一个：atrium product add 节点",
      );
    },
  },
};
