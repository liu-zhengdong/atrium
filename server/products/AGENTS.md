# server/products 约定

产品部（#404 第 3 步）。总体规范见根目录 `AGENTS.md`。

- 产品部是一块普通部分（`org_nodes`），`products` 表只多记它管哪个父节点、leader 与周期研究；认研究任务靠 `schedule_runs.task_id`，不给任务表加列。
- `product add` 一个事务：登记 leader → 建节点、写人话字段 → 记 `products` → `addSchedule`（试建一轮时连研究材料一起试取）→ 写 leader 备忘。任一步失败整条回滚，不留半个产品部。
- 研究详述：`brief.ts` 纯函数排版（交付格式与规矩在前，材料在后，空的一节写「（没有）」），`facts.ts` 取数——每类材料一条有界查询，范围是父节点及下层、不含产品部自己。
- 研究者没有 Atrium 的访问（执行者带 `ATRIUM_WORKER=1`，还可能上网读到注入内容），只在工作目录写 `choice.json`；任务完成时 `settle.ts` 读它、`addChoice` 并按拍板人投事件（`choices/notify.ts`），结果并进完成事件。读不到或不合格不挡任务完成、不加关卡。研究任务只在本机跑（文件要留在本机）。
