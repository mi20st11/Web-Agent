import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGit } from '../src/git.mjs';

async function sandbox(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wa-git-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const workspace = path.join(dir, 'ws');
  await fsp.mkdir(workspace);
  return { dir, workspace, stateDir: path.join(dir, 'state') };
}

async function usable(t, g) {
  const probe = await g.probe();
  if (!probe.ok) {
    t.skip(`这台机器没有 git：${probe.error}`);
    return false;
  }
  return true;
}

test('快照后改文件、加文件，恢复回到快照那一刻', async (t) => {
  const { workspace, stateDir } = await sandbox(t);
  await fsp.writeFile(path.join(workspace, 'a.txt'), 'old');
  const g = createGit({ workspace, stateDir });
  if (!(await usable(t, g))) return;

  const snap = await g.checkpoint('m1');
  assert.ok(snap.ok, snap.error);
  assert.match(snap.sha, /^[0-9a-f]{40}$/);

  await fsp.writeFile(path.join(workspace, 'a.txt'), 'new');
  await fsp.writeFile(path.join(workspace, 'b.txt'), 'created');
  await fsp.mkdir(path.join(workspace, 'src'));
  await fsp.writeFile(path.join(workspace, 'src', 'c.js'), 'created');

  const back = await g.restore(snap.sha);
  assert.ok(back.ok, back.error);
  assert.equal(await fsp.readFile(path.join(workspace, 'a.txt'), 'utf8'), 'old');
  assert.equal(await fsp.stat(path.join(workspace, 'b.txt')).then(() => true, () => false), false);
  assert.equal(await fsp.stat(path.join(workspace, 'src')).then(() => true, () => false), false);
});

test('排除目录不进快照，恢复时也不动它', async (t) => {
  const { workspace, stateDir } = await sandbox(t);
  await fsp.mkdir(path.join(workspace, 'node_modules'));
  await fsp.writeFile(path.join(workspace, 'node_modules', 'x.js'), 'kept');
  const g = createGit({ workspace, stateDir });
  if (!(await usable(t, g))) return;

  const snap = await g.checkpoint('m1');
  assert.ok(snap.ok, snap.error);
  await fsp.writeFile(path.join(workspace, 'node_modules', 'x.js'), 'changed');
  const back = await g.restore(snap.sha);
  assert.ok(back.ok, back.error);
  assert.equal(await fsp.readFile(path.join(workspace, 'node_modules', 'x.js'), 'utf8'), 'changed');
});

test('没有改动也能连续存底，返回不同提交', async (t) => {
  const { workspace, stateDir } = await sandbox(t);
  await fsp.writeFile(path.join(workspace, 'a.txt'), 'x');
  const g = createGit({ workspace, stateDir });
  if (!(await usable(t, g))) return;

  const one = await g.checkpoint('m1');
  const two = await g.checkpoint('m2');
  assert.ok(one.ok, one.error);
  assert.ok(two.ok, two.error);
  assert.notEqual(one.sha, two.sha);
});

test('快照编号不对就拒绝，不动工程目录', async (t) => {
  const { workspace, stateDir } = await sandbox(t);
  await fsp.writeFile(path.join(workspace, 'a.txt'), 'x');
  const g = createGit({ workspace, stateDir });
  if (!(await usable(t, g))) return;

  const bad = await g.restore('not-a-sha');
  assert.equal(bad.ok, false);
  assert.equal(await fsp.readFile(path.join(workspace, 'a.txt'), 'utf8'), 'x');
});

test('仓库数据放在 stateDir，工程目录里没有 .git', async (t) => {
  const { workspace, stateDir } = await sandbox(t);
  await fsp.writeFile(path.join(workspace, 'a.txt'), 'x');
  const g = createGit({ workspace, stateDir });
  if (!(await usable(t, g))) return;

  await g.checkpoint('m1');
  assert.equal(await fsp.stat(path.join(workspace, '.git')).then(() => true, () => false), false);
  assert.equal(await fsp.stat(path.join(stateDir, 'git', 'HEAD')).then(() => true, () => false), true);
});
