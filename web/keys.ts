/**
 * 输入法按键的判断：这类按键由输入法处理，不该当成应用快捷键。
 *
 * 选字时按回车确认候选词，Safari（WebKit）先发 compositionend 再发 keydown，
 * 所以那次回车上 isComposing 已经是 false，只有 keyCode 还是 229；只判
 * isComposing 会把它当成普通回车，触发发送消息、打开搜索结果、选中模型服务。
 * 有些第三方输入法在 Chrome 里也这样。
 */

/** 这次按键由输入法在处理。 */
export function isImeKey(event: {
  isComposing?: boolean;
  keyCode?: number;
}): boolean {
  return event.isComposing === true || event.keyCode === 229;
}

/**
 * 表单里确认候选词的那次回车，不该让表单隐式提交：在输入框里按回车提交表单是
 * 浏览器的默认行为，不受 keydown 处理器里的业务判断影响，要显式挡掉。
 *
 * 只挡「选字已经结束、keyCode 还是 229」那一次。正在选字（isComposing）时
 * 浏览器本来就不提交，也不必去动输入法自己的按键。挂在 form 的 onKeyDown 上。
 */
export function blockImeSubmit(event: {
  nativeEvent: { isComposing?: boolean; keyCode?: number };
  preventDefault(): void;
}): void {
  const native = event.nativeEvent;
  if (native.isComposing !== true && native.keyCode === 229) {
    event.preventDefault();
  }
}
