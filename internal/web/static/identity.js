// 只查完整身份键，名册保留名字；返回文字，由调用方按所在 HTML 上下文转义。
function identityText(id, names) {
  const name = names[id];
  const leader = /^a[1-9][0-9]*$/.exec(id);
  return leader && leader[0] === id
    ? `${name || "未登记负责人"}（${id}）`
    : name || id;
}
