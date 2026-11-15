import test from 'node:test';
import assert from 'node:assert/strict';
import { parseToolCalls, formatToolResults, formatToolError } from '../src/protocol.mjs';

const fence = '```';

test('解析最基本的 shell 调用', () => {
  const md = `${fence}tool\nshell\necho hello\n${fence}`;
  const calls = parseToolCalls(md);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'shell');
  assert.equal(calls[0].body, 'echo hello');
  assert.deepEqual(calls[0].args, {});
});

test('解析带 JSON 参数的 write 调用', () => {
  const md = `${fence}tool\nwrite {"path":"src/a.txt"}\n内容\n第二行\n${fence}`;
  const [call] = parseToolCalls(md);
  assert.equal(call.name, 'write');
  assert.deepEqual(call.args, { path: 'src/a.txt' });
  assert.equal(call.body, '内容\n第二行');
});

test('支持 ~~~ 围栏和四个反引号', () => {
  const tilde = parseToolCalls('~~~tool\nlist {"path":"."}\n~~~');
  assert.equal(tilde.length, 1);
  assert.equal(tilde[0].name, 'list');

  const quad = parseToolCalls(`\`\`\`\`tool
write {"path":"a.md"}
${fence}js
const x = 1;
${fence}
\`\`\`\``);
  assert.equal(quad.length, 1);
  assert.equal(quad[0].name, 'write');
  assert.match(quad[0].body, /```js\nconst x = 1;\n```/);
});

test('没写 label 但首行是工具名，也认', () => {
  const md = `${fence}\nread {"path":"a.txt"}\n${fence}`;
  const [call] = parseToolCalls(md);
  assert.equal(call.name, 'read');
});

test('普通代码块不执行', () => {
  const md = `${fence}js\nconst shell = 1;\n${fence}`;
  assert.deepEqual(parseToolCalls(md), []);

  const unknown = `${fence}\nnot_a_tool\nbody\n${fence}`;
  assert.deepEqual(parseToolCalls(unknown), []);
});

test('未闭合的围栏不产生调用', () => {
  const md = `${fence}tool\nshell\necho hi`;
  assert.deepEqual(parseToolCalls(md), []);
});

test('一轮可以解析多个工具', () => {
  const md = [
    `${fence}tool`, 'read {"path":"a.txt"}', fence,
    '', '中间的解释文字', '',
    `${fence}tool`, 'list {"path":"src"}', fence,
  ].join('\n');
  const calls = parseToolCalls(md);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.name), ['read', 'list']);
});

test('JSON 写坏时给出 error 而不是抛异常', () => {
  const md = `${fence}tool\nwrite {"path": }\nbody\n${fence}`;
  const [call] = parseToolCalls(md);
  assert.equal(call.name, 'write');
  assert.ok(call.error);
  assert.deepEqual(call.args, {});
});

test('formatToolResults 结构稳定', () => {
  const text = formatToolResults([
    { name: 'shell', ok: true, ms: 1234, output: 'ok' },
    { name: 'read', ok: false, ms: 12, output: 'boom' },
  ]);
  assert.match(text, /【工具结果】/);
  assert.match(text, /\[1\] shell → 成功/);
  assert.match(text, /\[2\] read → 失败/);
  assert.match(text, /【请继续】/);
});

test('formatToolError 带工具名', () => {
  assert.match(formatToolError('write', '参数不对'), /write/);
  assert.match(formatToolError('write', '参数不对'), /参数不对/);
});

test('围栏直接写工具名、正文是命令（真实站点常见）', () => {
  const calls = parseToolCalls(`${fence}shell\necho 你好\nnode -v\n${fence}`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'shell');
  assert.equal(calls[0].body, 'echo 你好\nnode -v');
  assert.deepEqual(calls[0].args, {});
});

test('围栏写工具名且首行重复工具名+参数时，参数照样解析', () => {
  const calls = parseToolCalls(`${fence}write\nwrite {"path":"a.txt"}\nhi\n${fence}`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'write');
  assert.deepEqual(calls[0].args, { path: 'a.txt' });
  assert.equal(calls[0].body, 'hi');
});

test('围栏写未知名字、正文也不是工具名，不执行', () => {
  assert.equal(parseToolCalls(`${fence}python\nprint(1)\n${fence}`).length, 0);
});
