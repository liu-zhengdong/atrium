import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import type { SchedulePump } from "../schedules/runtime.ts";
import { addProduct, ensureProductTables, listProducts } from "./model.ts";

/** 产品部（atrium product add / ls）：成立只给用户（leader 规则表没登记，默认拒绝）。 */
export function registerProductRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  pump: SchedulePump,
) {
  ensureProductTables(db);
  app.post("/api/products", { bodyLimit: 16 * 1024 }, (request, reply) =>
    reply
      .code(201)
      .send(addProduct(db, request.body, (body) => pump.add(body))),
  );
  app.get("/api/products", (request) => {
    const node = (request.query as { node?: string } | undefined)?.node;
    return listProducts(db, node || undefined);
  });
}
