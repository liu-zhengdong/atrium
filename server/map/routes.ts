import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveActor } from "../actor.ts";
import { Problem } from "../problem.ts";
import { packageRoot } from "../service-state.ts";
import { ensureOrgTables } from "../org/schema.ts";
import { mapContext, parseMax } from "./context.ts";
import { LINK_TTL_MS, MapLogin, sessionCookie } from "./login.ts";
import { mapNode, mapNow, mapTree, parseDepth, type LiveRow } from "./view.ts";
import { ensureMapWatch, startMapWatch, type MapRepeat } from "./watch.ts";
import { mapLeader, mapLeaders } from "./leaders.ts";
import { addMap, editMap, type MapAdd, type MapEdit } from "./write.ts";
import {
  mapPartRoles,
  mapRole,
  mapRoles,
  mapSkills,
  mapWorker,
  mapWorkers,
} from "./people.ts";

/**
 * 全景图的接口与网页（#322 第 4 步）。同一份数据两张脸：
 * - Agent 走命令行（用户令牌）：读 tree／nodes／now／context，写 edit／add；
 * - 人走网页（一次性链接换来的本机会话）：只能读 tree／nodes／now 与失效通知 stream，不能写。
 * 网页是服务直接托管的静态文件（原生 ES 模块、手写样式），不引入前端构建链。
 */

// 按包根取：编译后的服务在 dist/ 下，静态文件仍随包放在 server/map/web/（t117）。
const WEB = join(packageRoot, "server", "map", "web");
const asset = (name: string) => readFileSync(join(WEB, name), "utf8");
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
export const isLoopback = (address: string | undefined) =>
  LOOPBACK.has(address ?? "");

/** 会话失效时浏览器看到的页面：说清怎么重新进，不给别的。 */
export const expiredPage = (message: string) => `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Atrium 全景</title>
<body style="font:16px/1.6 -apple-system,'PingFang SC',sans-serif;max-width:32em;margin:18vh auto;padding:0 20px;color:#333">
<h1 style="font-size:20px;margin:0 0 8px">${message}</h1>
<p style="margin:0;color:#666">在终端运行 <code style="background:#f2f2f2;padding:2px 6px;border-radius:4px">atrium map</code>，会重新打开一个登录链接。</p>
</body></html>`;

type Q = Record<string, string | undefined>;
const q = (value: unknown) => (value ?? {}) as Q;
const id = (request: FastifyRequest) => (request.params as { id: string }).id;

export type MapRouteOptions = {
  /** 看板的行（带执行者与最近动作）；取不到就当没有。 */
  live: () => Promise<readonly LiveRow[]>;
  login: MapLogin;
  /** 失效通知的检查间隔，测试缩短。 */
  pollMs?: number;
  /** 变化检测（测试可注入计数）；缺省读 map_revision。 */
  detect?: (db: DatabaseSync) => string | number;
  /** 定时器（测试可手动打点）；缺省 setInterval。 */
  repeat?: MapRepeat;
};

export function registerMapRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  options: MapRouteOptions,
) {
  ensureOrgTables(db);
  ensureMapWatch(db);
  const live = () => options.live().catch(() => [] as readonly LiveRow[]);
  const pages = {
    "/map": ["text/html; charset=utf-8", asset("index.html")],
    "/map/app.js": ["text/javascript; charset=utf-8", asset("app.js")],
    "/map/boot.js": ["text/javascript; charset=utf-8", asset("boot.js")],
    "/map/format.js": ["text/javascript; charset=utf-8", asset("format.js")],
    "/map/style.css": ["text/css; charset=utf-8", asset("style.css")],
  } as const;
  for (const [url, [type, body]] of Object.entries(pages))
    app.get(url, (_request, reply) =>
      reply
        .header("content-type", type)
        .header("cache-control", "no-store")
        .header("content-security-policy", CSP)
        .header("x-frame-options", "DENY")
        .send(body),
    );

  // 一次性链接：code 对上就换会话 cookie，跳到全景页（node 只认 oN）。
  app.get("/map/login", (request, reply) => {
    const query = q(request.query);
    const session = options.login.exchange(query.code);
    if (!session)
      return reply
        .code(401)
        .header("content-type", "text/html; charset=utf-8")
        .header("cache-control", "no-store")
        .send(expiredPage("登录链接已失效（只能用一次，2 分钟内有效）"));
    const node = /^o[1-9][0-9]{0,8}$/.test(query.node ?? "")
      ? `#${query.node}`
      : "";
    return reply
      .code(303)
      .header("set-cookie", sessionCookie(session.token))
      .header("cache-control", "no-store")
      .header("location", `/map${node}`)
      .send();
  });
  // 只有持用户令牌的命令行能签发登录链接。
  app.post("/api/map/login", { bodyLimit: 1024 }, () => {
    const link = options.login.link();
    return {
      path: `/map/login?code=${link.token}`,
      expires_at: link.expires_at,
      ttl_ms: LINK_TTL_MS,
    };
  });

  app.get("/api/map/tree", (request) => {
    const query = q(request.query);
    return mapTree(db, query.root || undefined, parseDepth(query.depth));
  });
  app.get("/api/map/nodes/:id", async (request) => {
    const query = q(request.query);
    const node = mapNode(db, id(request), await live());
    return query.depth === undefined
      ? node
      : { ...node, tree: mapTree(db, node.ref, parseDepth(query.depth)).tree };
  });
  app.get("/api/map/now", async () => mapNow(db, await live()));
  // 组织共用的专员、技能、执行者（组织根与专员页）。旧 roles 路径暂留兼容。
  app.get("/api/map/roles", () => mapRoles(db));
  app.get("/api/map/roles/:id", async (request) =>
    mapRole(db, id(request), await live()),
  );
  // 带 part 时只列这一部分能请的（本部分、上级、牵涉部分、全组织，各注明哪一档）。
  app.get("/api/map/specialists", (request) => {
    const part = q(request.query).part;
    return part
      ? { specialists: mapPartRoles(db, part).roles }
      : { specialists: mapRoles(db).roles };
  });
  app.get("/api/map/specialists/:id", async (request) =>
    mapRole(db, id(request), await live()),
  );
  app.get("/api/map/skills", () => mapSkills(db));
  // 负责人（leader）：组织根的页签与负责人页；/api/map/leaders/secretary 是秘书页。
  app.get("/api/map/leaders", () => mapLeaders(db));
  app.get("/api/map/leaders/:id", (request) => mapLeader(db, id(request)));
  app.get("/api/map/workers", (request) =>
    mapWorkers(db, q(request.query).role),
  );
  app.get("/api/map/workers/:id", (request) => mapWorker(db, id(request)));
  app.get("/api/map/context/:id", (request) =>
    mapContext(
      db,
      id(request),
      parseMax(q(request.query).max),
      q(request.query).also,
    ),
  );
  app.patch("/api/map/nodes/:id", { bodyLimit: 64 * 1024 }, (request) =>
    editMap(
      db,
      id(request),
      (request.body ?? {}) as MapEdit,
      resolveActor(db, q(request.query).as),
    ),
  );
  app.post("/api/map/nodes", { bodyLimit: 16 * 1024 }, (request, reply) =>
    reply
      .code(201)
      .send(
        addMap(
          db,
          (request.body ?? {}) as MapAdd,
          resolveActor(db, q(request.query).as),
        ),
      ),
  );

  // 失效通知：全服务一份变更检测，指纹变了给所有连接推 changed；空闲时定期发注释保活。
  const watch = startMapWatch(db, {
    pollMs: options.pollMs,
    detect: options.detect ? () => options.detect!(db) : undefined,
    repeat: options.repeat,
  });
  const streams = new Set<() => void>();
  let closing = false;
  app.addHook("preClose", async () => {
    closing = true;
    watch.close();
    for (const close of [...streams]) close();
  });
  app.get("/api/map/stream", (request, reply: FastifyReply) => {
    if (closing) return reply.code(503).send({ restarting: true });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      connection: "keep-alive",
    });
    res.write(`retry: 3000\nevent: hello\ndata: {}\n\n`);
    const unsub = watch.subscribe((event) => {
      res.write(
        event === "changed" ? "event: changed\ndata: {}\n\n" : ": ping\n\n",
      );
    });
    const close = () => {
      if (!streams.delete(close)) return;
      unsub();
      res.end();
    };
    streams.add(close);
    request.raw.on("close", close);
  });
}

/** 路由上的会话校验失败（非本机、没登录）时抛的错。 */
export const notLocal = () =>
  new Problem(403, "全景网页只接受本机访问", "conflict");
