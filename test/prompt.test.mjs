import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../src/prompt.mjs';

const WIN = {
  platform: 'win32', osLabel: 'Windows 11', release: '10.0.26100', arch: 'x64',
  shell: 'PowerShell 5.1', pathSep: '\\', node: '22.14.0',
  python: { command: 'python', version: '3.12.4', major: 3, minor: 12 },
};

const LIN = {
  platform: 'linux', osLabel: 'Ubuntu 24.04', release: '6.8.0-45-generic', arch: 'x64',
  shell: 'bash', pathSep: '/', node: '22.14.0',
  python: { command: 'python3', version: '3.12.4', major: 3, minor: 12 },
};

const prompt = (env, extra = {}) => buildSystemPrompt({ workspace: 'D:/demo', toolsHelp: 'shell', env, ...extra });

test('自动模式：Windows 机器写 PowerShell 和 Python 版本', () => {
  const text = prompt(WIN, { profile: 'auto' });
  assert.match(text, /Windows 11/);
  assert.match(text, /PowerShell 5\.1（不是 bash）/);
  assert.match(text, /Python 3\.12\.4（命令是 python）/);
  assert.match(text, /Node v22\.14\.0/);
  assert.doesNotMatch(text, /目标系统/);
});

test('自动模式：Linux 机器写 bash', () => {
  const text = prompt(LIN, { profile: 'auto' });
  assert.match(text, /系统：Linux/);
  assert.match(text, /命令行是 bash/);
  assert.match(text, /Python 3\.12\.4（命令是 python3）/);
});

test('手选 Linux 而本机是 Windows：按 Linux 写，但说清执行层还是 PowerShell', () => {
  const text = prompt(WIN, { profile: 'linux' });
  assert.match(text, /目标系统：Linux（bash/);
  assert.match(text, /本机实际是 Windows 11，执行层还是 PowerShell/);
});

test('手选 Windows 而本机是 Linux：按 Windows 写', () => {
  const text = prompt(LIN, { profile: 'windows' });
  assert.match(text, /PowerShell 5\.1（不是 bash）/);
  assert.doesNotMatch(text, /目标系统/);
});

test('没装 Python 时明说，不瞎编版本', () => {
  const text = prompt({ ...WIN, python: null }, { profile: 'auto' });
  assert.match(text, /没找到 Python/);
  assert.doesNotMatch(text, /Python 3\./);
});

test('没传 env 时退回通用说法，不报错', () => {
  const text = prompt(null, { profile: 'auto' });
  assert.match(text, /PowerShell/);
});

test('Git 段跟着开关走', () => {
  assert.match(prompt(WIN, { git: { enabled: true } }), /自动快照开着/);
  assert.match(prompt(WIN, { git: { enabled: false } }), /自动快照现在没开/);
});
