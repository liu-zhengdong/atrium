# 临时 pi-acp 构建

`liuser-pi-acp-0.2.0.tgz` 是本次联调所需、尚未发布的 pi-acp 构建。Atrium 用本地包保证 `npm ci` 可以直接运行，无需开放 npm Git 依赖或提前发布 npm。

- 源码：[liu-zhengdong/pi-acp@eda0d15](https://github.com/liu-zhengdong/pi-acp/commit/eda0d151067f3d9a3737429ddbe62f6773924944)
- 生成：源码 `npm run validate` 通过后，`npm pack --ignore-scripts`。
- 更新：替换同名包时同时核对 lockfile 的 SHA-512 与本文 SHA-256；使用空缓存运行 `npm ci --cache "$(mktemp -d)"`，再跑检查。不能仅以热缓存安装成功判断归档可用。
- SHA-256：`ab79ec928c686593bcefbe92729c0d44a9e6a8860600810a58a37bb604e81b21`
- 包内保留上游及 fork 的 LICENSE、README 与 npm 元数据；无需额外复制业务代码到 Atrium。

发布对应版本后，将依赖和 lockfile 切回注册表版本，再删除此临时包及说明。当前代价约 278 KiB，换取两个未合并仓库之间可复现的直接安装。
