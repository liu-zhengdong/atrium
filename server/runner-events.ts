import { runtimeEvents, type RuntimeEventPage } from "../shared/trace.ts";

type Item = RuntimeEventPage["items"][number];
type Stream = {
  runtimeId: string;
  generation: string;
  sessionId: string;
  items: Item[];
  readAfter: number;
  lostThrough: number;
};

/** Bounded in-memory relay, not a durable journal. Gaps are explicit. */
export class RunnerEvents {
  private streams = new Map<string, Stream>();
  private bytes = 0;
  constructor(private limitBytes = 2 * 1024 * 1024) {}
  private key(runtimeId: string, generation: string) {
    return `${runtimeId}\0${generation}`;
  }
  add(raw: unknown) {
    const page = runtimeEvents.parse(raw);
    const key = this.key(page.runtimeId, page.generation);
    let stream = this.streams.get(key);
    if (!stream || stream.sessionId !== page.sessionId) {
      if (stream) this.drop(stream);
      stream = {
        runtimeId: page.runtimeId,
        generation: page.generation,
        sessionId: page.sessionId,
        items: [],
        readAfter: 0,
        lostThrough: 0,
      };
      this.streams.set(key, stream);
    }
    if (page.gap && page.items.length)
      stream.lostThrough = Math.max(stream.lostThrough, page.items[0].seq - 1);
    for (const item of page.items) {
      if (item.seq <= stream.readAfter) continue;
      if (item.seq !== stream.readAfter + 1)
        stream.lostThrough = Math.max(stream.lostThrough, item.seq - 1);
      stream.items.push(item);
      stream.readAfter = item.seq;
      this.bytes += Buffer.byteLength(JSON.stringify(item));
    }
    this.trim();
    return stream.readAfter;
  }
  private drop(stream: Stream) {
    for (const item of stream.items)
      this.bytes -= Buffer.byteLength(JSON.stringify(item));
    this.streams.delete(this.key(stream.runtimeId, stream.generation));
  }
  private trim() {
    while (this.bytes > this.limitBytes) {
      const victim = [...this.streams.values()].find((s) => s.items.length);
      if (!victim) break;
      const item = victim.items.shift()!;
      this.bytes -= Buffer.byteLength(JSON.stringify(item));
      victim.lostThrough = Math.max(victim.lostThrough, item.seq);
    }
  }
  page(
    runtimeId: string,
    generation: string,
    sessionId: string,
    after: number,
    limit: number,
  ): RuntimeEventPage {
    const stream = this.streams.get(this.key(runtimeId, generation));
    if (!stream || stream.sessionId !== sessionId)
      throw new Error("运行代际或会话未找到；轨迹需标记缺口");
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error("轨迹分页参数无效");
    while (stream.items[0] && stream.items[0].seq <= after) {
      const item = stream.items.shift()!;
      this.bytes -= Buffer.byteLength(JSON.stringify(item));
      stream.lostThrough = Math.max(stream.lostThrough, item.seq);
    }
    const available = stream.items.filter((item) => item.seq > after);
    const items = available.slice(0, limit);
    return {
      runtimeId,
      generation,
      sessionId,
      items,
      nextAfter: items.at(-1)?.seq ?? after,
      hasMore: available.length > items.length,
      gap: items.some(
        (item, index) =>
          item.seq !== (index ? items[index - 1].seq : after) + 1,
      ),
    };
  }
  cursor(runtimeId: string, generation: string) {
    return this.streams.get(this.key(runtimeId, generation))?.readAfter ?? 0;
  }
}
