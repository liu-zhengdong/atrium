const historyKind = {created:"建立",edited:"修改",note:"备注",status:"状态变化",escalated:"上报"};
/* 结构角色与经历：名字只查服务端名册投影，正文原样转义。 */
function identityHTML(id, label = identityText(id, nav.names)) {

 const match = label.match(/^(.*)(（a[1-9][0-9]*）)$/s);
 const text = match ? `${esc(match[1])}<span class="identity-id">${esc(match[2])}</span>` : esc(label);
 const leader = nav.identity_links[id];
 return leader ? `<a href="#${esc(leader)}">${text}</a>` : text;
}
function partiesHTML(d) {
 const p = d.parties;
 return `<dl class="facts"><dt>当前处理人</dt><dd>${identityHTML(p.owner, d.party_labels.owner)}</dd><dt>分派人</dt><dd>${identityHTML(p.by, d.party_labels.by)}</dd></dl>`;
}
function historyHTML(d) {
 return d.history?.length ? `<details class="history"><summary>${icon.chev}经历 · 最近 ${d.history.length} 条</summary>${d.history.map(e => `<div class="history-event"><div class="quiet">${esc(date(e.at))} ${esc(clock(e.at))} · ${e.kind === "escalated" ? "上报人" : esc(historyKind[e.kind] || e.kind)} · ${identityHTML(e.actor, d.history_labels[e.actor])}</div>${e.body ? `<pre>${esc(e.body)}</pre>` : ""}</div>`).join("")}</details>` : "";
}
