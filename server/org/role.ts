import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { nodeByAddress, one, ref, type DocRow } from "./model.ts";

/** Resolve a task role to the charter kept in Atrium. Legacy role names use the Atrium project. */
export function roleCharter(
  db: DatabaseSync,
  role: string,
): { body: string; ref: string } | undefined {
  const legacy = /^(?:modules|concerns)\/(.+)$/.exec(role.replace(/\.md$/, ""));
  const address =
    /^o[1-9][0-9]*$/.test(role) || (role.includes("/") && !legacy)
      ? role
      : `atrium/${legacy?.[1] ?? role.replace(/\.md$/, "")}`;
  try {
    const node = nodeByAddress(db, address);
    const charter = one<DocRow>(
      db,
      "SELECT * FROM org_docs WHERE node_id=? AND doc='charter'",
      node.id,
    );
    return { body: charter?.body ?? "", ref: ref(node.id) };
  } catch (error) {
    if (error instanceof Problem && error.statusCode === 404) return undefined;
    throw error;
  }
}
