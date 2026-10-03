const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const { strict: assert } = require('node:assert');
const { join } = require('node:path');
const format = runInNewContext(readFileSync(join(__dirname, '../static/identity.js'), 'utf8') + '\nidentityText');
const names = { a1: '甲', a10: '乙<&"', u1: '你', secretary: '秘书', h1: '本机' };
for (const [id, want] of [
  ['a1', '甲（a1）'], ['a10', '乙<&"（a10）'], ['a99', '未登记负责人（a99）'],
  ['a1\n', 'a1\n'], ['a1\r', 'a1\r'], ['a2', '未登记负责人（a2）'], ['a0', 'a0'], ['a01', 'a01'], ['a1 正文', 'a1 正文'],
  ['u1', '你'], ['secretary', '秘书'], ['worker', 'worker'], ['h1', '本机'], ['', ''],
]) assert.equal(format(id, names), want);
names.a1 = '改名';
assert.equal(format('a1', names), '改名（a1）');
delete names.a1;
assert.equal(format('a1', names), '未登记负责人（a1）');
console.log('identity: 16 个反向与回归样本通过');
