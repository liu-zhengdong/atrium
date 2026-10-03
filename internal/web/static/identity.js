// 身份规则由服务端 org.DisplayIdentity 呈现；此处只查结构键。
function identityText(id, names) {
  return nav.identity_labels?.[id] || names[id] || id;
}
