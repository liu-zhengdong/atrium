const pending = new Set<symbol>();
export const hasUnsaved = () => pending.size > 0;
export function trackUnsaved(dirty: boolean) {
  const key = Symbol();
  if (dirty) pending.add(key);
  return () => {
    pending.delete(key);
  };
}
let approved = false;
export function confirmLeave() {
  if (approved) {
    approved = false;
    return true;
  }
  return !hasUnsaved() || window.confirm("有未保存的修改，确定离开吗？");
}
export function allowNextNavigation() {
  approved = true;
}
