// server/tasks/bridge-plan.ts
var REMIND_MS = 30 * 6e4;
var LISTEN_EVERY_MS = 3e4;
var LISTEN_TTL_SECONDS = 90;
var BRIDGE_VIA = "claude-code \u4F1A\u8BDD\uFF0C\u7ECF\u6CE8\u5165";
var SENT_LIMIT = 1e3;
function planBatch(sent, events, now, remindMs = REMIND_MS) {
  const fresh = [];
  const remind = [];
  for (const event of events) {
    if (event.acked_at !== null) continue;
    const before = sent.get(event.id);
    if (!before || before.updated_at !== event.updated_at) fresh.push(event);
    else if (now - before.sent_at >= remindMs) remind.push(event);
  }
  return { fresh, remind };
}
function recordSent(sent, events, now, limit = SENT_LIMIT) {
  for (const event of events) {
    sent.delete(event.id);
    sent.set(event.id, { updated_at: event.updated_at, sent_at: now });
  }
  for (const id of sent.keys()) {
    if (sent.size <= limit) break;
    sent.delete(id);
  }
}
var detailOf = (event) => event.detail ?? {};
function bridgeLine(event) {
  const detail = detailOf(event);
  const text = (key, max) => typeof detail[key] === "string" ? detail[key].split("\n", 1)[0].slice(0, max) : "";
  const reason = text("message", 160) || text("reason", 160);
  return [
    `#${event.id}`,
    event.task ?? "",
    event.kind,
    text("title", 40),
    event.count > 1 ? `\uFF08\u5408\u5E76 ${event.count} \u6B21\uFF09` : "",
    text("pr_url", 200),
    reason ? `\xB7 ${reason}` : ""
  ].filter(Boolean).join(" ");
}
function bridgePrompt(batch, remindMs = REMIND_MS) {
  const all = [...batch.fresh, ...batch.remind];
  const ids = all.map((event) => event.id);
  const tasks = [
    ...new Set(all.flatMap((event) => event.task ? [event.task] : []))
  ];
  const minutes = Math.round(remindMs / 6e4);
  return [
    batch.fresh.length ? `\u3010Atrium \u4E8B\u4EF6\u3011${batch.fresh.length} \u6761\u8981\u5904\u7406\u7684\u4E8B\u4EF6\uFF08\u7F16\u53F7 ${batch.fresh.map((event) => event.id).join("\u3001")}\uFF09\uFF1A` : `\u3010Atrium \u4E8B\u4EF6\u3011\u63D0\u9192\uFF1A${batch.remind.length} \u6761\u4E8B\u4EF6\u9001\u8FC7 ${minutes} \u5206\u949F\u8FD8\u6CA1\u786E\u8BA4\uFF1A`,
    ...batch.fresh.map((event) => `- ${bridgeLine(event)}`),
    ...batch.fresh.length && batch.remind.length ? [`\u9001\u8FC7 ${minutes} \u5206\u949F\u8FD8\u6CA1\u786E\u8BA4\uFF1A`] : [],
    ...batch.remind.map((event) => `- ${bridgeLine(event)}`),
    "",
    tasks.length ? `\u770B\u8BE6\u60C5\uFF1A${tasks.map((task) => `atrium task show ${task}`).join("\uFF1B")}\uFF1B\u5168\u90E8\uFF1Aatrium events` : "\u770B\u8BE6\u60C5\uFF1Aatrium events",
    `\u5904\u7406\u5B8C\u786E\u8BA4\uFF1Aatrium events ack ${ids.join(" ")}`
  ].join("\n");
}
function inboxLines(token, text) {
  return [
    JSON.stringify({ type: "auth", token }),
    JSON.stringify({
      type: "user",
      message: { role: "user", content: text }
    })
  ];
}
function bridgeClaim(current, socket, alive) {
  if (!current || !alive(current.pid)) return "start";
  return current.socket === socket ? "running" : "takeover";
}
function parseBridgeRecord(text) {
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    return Number.isInteger(value.pid) && (value.pid ?? 0) > 0 && typeof value.socket === "string" && typeof value.started_at === "number" ? value : null;
  } catch {
    return null;
  }
}

export {
  REMIND_MS,
  LISTEN_EVERY_MS,
  LISTEN_TTL_SECONDS,
  BRIDGE_VIA,
  planBatch,
  recordSent,
  bridgePrompt,
  inboxLines,
  bridgeClaim,
  parseBridgeRecord
};
