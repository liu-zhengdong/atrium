import { Readable, Writable } from "node:stream";
import { createWebSocketStream, type WebSocket } from "ws";
import { ndJsonStream } from "@agentclientprotocol/sdk";

// ACP keeps its JSON-RPC framing; WebSocket only replaces the byte transport.
export function acpStream(socket: WebSocket) {
  const duplex = createWebSocketStream(socket);
  // Node and DOM declare different BYOB generic constraints; the runtime is the native Web Stream.
  return ndJsonStream(
    Writable.toWeb(duplex),
    Readable.toWeb(duplex) as unknown as ReadableStream<Uint8Array>,
  );
}
