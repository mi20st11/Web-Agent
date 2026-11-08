import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPolicy, isDangerous } from '../src/policy.mjs';
import { applyEdits, capOutput } from '../src/tools.mjs';

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-agent-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
  return dir;
}

test('危险命令识别', () => {
  const danger = (cmd) => isDangerous(cmd).dangerous;
  assert.equal(danger('Remove-Item -Recurse C:\\Windows'), true);
  assert.equal(danger('rm -rf /'), true);
  assert.equal(danger('git reset --hard HEAD'), true);
  assert.equal(danger('format D:'), true);
  assert.equal(danger('Get-ChildItem'), false);
  assert.equal(danger('Remove-Item .\\build\\out.txt'), false);
  assert.equal(danger('node --test "test/*.test.mjs"'), false);
});

test('路径必须留在工作区内', async (t) => {
  const dir = await tempDir(t);
  const policy = createPolicy({ workspace: dir, logFile: '', backupDir: '' });

  assert.equal(policy.resolveInside('a/b.txt'), path.join(dir, 'a', 'b.txt'));
  assert.equal(policy.resolveInside('.', { allowRoot: true }), dir);
  assert.throws(() => policy.resolveInside('..'), /工作区外/);
  assert.throws(() => policy.resolveInside(path.join(dir, '..', 'x.txt')), /工作区外/);
  assert.throws(() => policy.resolveInside('.'), /具体文件路径/);
});

test('写前备份保留相对路径', async (t) => {
  const dir = await tempDir(t);
  const backupDir = path.join(dir, '.web-agent', 'backups');
  const policy = createPolicy({ workspace: dir, logFile: '', backupDir });

  const file = path.join(dir, 'src', 'a.txt');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'old');

  const dest = await policy.backup(file);
  assert.ok(dest);
  assert.equal(await fs.readFile(dest, 'utf8'), 'old');
  assert.ok(dest.startsWith(backupDir));
  assert.match(dest, /[\\/]src[\\/]a\.txt$/);

  assert.equal(await policy.backup(path.join(dir, 'not-exist.txt')), null);
});

test('applyEdits 替换、唯一性和 CRLF', () => {
  const original = 'a\nb\nc\n';
  const blocks = [{ search: 'b', replace: 'B' }];
  assert.equal(applyEdits(original, blocks).text, 'a\nB\nc\n');

  const two = applyEdits(original, [
    { search: 'a', replace: 'A' },
    { search: 'c', replace: 'C' },
  ]);
  assert.equal(two.text, 'A\nb\nC\n');
  assert.equal(two.applied.length, 2);

  assert.throws(() => applyEdits(original, [{ search: 'zzz', replace: 'x' }]), /找不到/);
  assert.throws(() => applyEdits('x\nx\n', [{ search: 'x', replace: 'y' }]), /不止一次/);

  const crlf = 'a\r\nb\r\n';
  assert.equal(applyEdits(crlf, [{ search: 'b', replace: 'B' }]).text, 'a\r\nB\r\n');
});

test('capOutput 保留头尾并标注省略', () => {
  const text = 'A'.repeat(5000) + 'B'.repeat(5000) + 'C'.repeat(5000);
  const out = capOutput(text, 3000);
  assert.ok(out.length < 3500);
  assert.match(out, /中间省略/);
  assert.ok(out.startsWith('A'));
  assert.ok(out.trimEnd().endsWith('C'));
});
