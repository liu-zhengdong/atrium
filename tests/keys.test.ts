import { test } from "node:test";
import { strict as assert } from "node:assert";
import { blockImeSubmit, isImeKey } from "../web/keys.ts";

test("输入法按键：选字中或 keyCode 229 都算", () => {
  assert.equal(isImeKey({ isComposing: true, keyCode: 13 }), true);
  assert.equal(isImeKey({ isComposing: false, keyCode: 229 }), true);
  assert.equal(isImeKey({ isComposing: false, keyCode: 13 }), false);
  assert.equal(isImeKey({ isComposing: false, keyCode: 27 }), false);
  assert.equal(isImeKey({}), false);
});

function submitEvent(native: { isComposing?: boolean; keyCode?: number }) {
  const state = { prevented: false };
  return {
    nativeEvent: native,
    preventDefault: () => {
      state.prevented = true;
    },
    state,
  };
}

test("表单隐式提交：只挡「选字已结束、keyCode 还是 229」那一次回车", () => {
  const safari = submitEvent({ isComposing: false, keyCode: 229 });
  blockImeSubmit(safari);
  assert.equal(safari.state.prevented, true);

  const composing = submitEvent({ isComposing: true, keyCode: 229 });
  blockImeSubmit(composing);
  assert.equal(composing.state.prevented, false);

  const plain = submitEvent({ isComposing: false, keyCode: 13 });
  blockImeSubmit(plain);
  assert.equal(plain.state.prevented, false);
});
