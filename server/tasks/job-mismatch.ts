/** 文件事实只用于提醒，不能据此阻断交付。 */
export function jobMismatch(
  role: string,
  files: readonly string[],
): string | null {
  if (files.length < 2) return null;
  const ui = files.filter((path) =>
    /(^|\/)(web|frontend|components|pages)\/|\.(tsx|jsx|vue|svelte|css|scss|html)$/i.test(
      path,
    ),
  ).length;
  if (role === "后端" && ui > files.length / 2)
    return `任务标为后端，但 ${ui}/${files.length} 个改动文件属于界面，请核对角色`;
  if (role === "前端" && files.length - ui > files.length / 2)
    return `任务标为前端，但 ${files.length - ui}/${files.length} 个改动文件属于非界面，请核对角色`;
  return null;
}
