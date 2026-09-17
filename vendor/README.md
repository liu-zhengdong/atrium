# 临时 pi-acp 构建

`liuser-pi-acp-0.2.0.tgz` 是本次联调所需、尚未发布的 pi-acp 构建。Atrium 用本地包保证 `npm ci` 可以直接运行，无需开放 npm Git 依赖或提前发布 npm。

- 源码：[liu-zhengdong/pi-acp@ee3e0e8](https://github.com/liu-zhengdong/pi-acp/commit/ee3e0e8f2b9d078d7f10257ec7fc1f069c287678)
- 生成：源码 `npm run validate` 通过后，`npm pack --ignore-scripts`。
- SHA-256：`417d7b4d991eef90c072f64005b5411b4a5a316332966b9b56da3a2478ccbe4a`
- 包内保留上游及 fork 的 LICENSE、README 与 npm 元数据；无需额外复制业务代码到 Atrium。

发布对应版本后，将依赖和 lockfile 切回注册表版本，再删除此临时包及说明。当前代价约 246 KiB，换取两个未合并仓库之间可复现的直接安装。
