import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/agent.mjs';
import { createGit } from '../src/git.mjs';
import { workspaceStateDir } from '../src/config.mjs';

/** 不碰浏览器的假网页端：第一轮让 agent 写文件，第二轮说干完了。 */
function fakeSite(replies) {
  const queue = [...replies];
  const seen = [];
  return {
    name: 'Mock',
    seen,
    async check() {
      return { ok: true, signedOut: false, hasEditor: true, storageBlocked: false, url: 'mock://', title: 'Mock' };
    },
    async ask(payload) {
      seen.push(String(payload));
      return queue.length ? queue.shift() : '好了';
    },
    async stop() {},
    async newChat() { return true; },
    async focus() { return true; },
  };
}

test('回答卡片带上请求的动作；恢复回到这条回答之前', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wa-agent-'));
  const workspace = path.join(dir, 'ws');
  await fsp.mkdir(workspace);
  await fsp.writeFile(path.join(workspace, 'a.txt'), 'old');

  const stateDir = workspaceStateDir(workspace);
  const probe = await createGit({ workspace, stateDir }).probe();
  t.after(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.rm(stateDir, { recursive: true, force: true });
  });
  if (!probe.ok) {
    t.skip(`这台机器没有 git：${probe.error}`);
    return;
  }

  const site = fakeSite([
    '我来改一下。\n```tool\nwrite {"path":"a.txt"}\nnew\n```\n改好了。',
    '改完了。',
  ]);
  const agent = new Agent({
    site,
    workspace,
    settings: { gitEnabled: true, autoApprove: true, maxSteps: 3, replyTimeoutMs: 10_000 },
  });
  t.after(() => agent.dispose());

  const sent = await agent.send('把 a.txt 改成 new');
  assert.equal(sent.ok, true, sent.error);
  assert.equal(await fsp.readFile(path.join(workspace, 'a.txt'), 'utf8'), 'new');

  const card = agent.timeline.find((x) => x.type === 'assistant' && x.calls?.length);
  assert.ok(card, '应该有一条带动作的回答');
  assert.deepEqual(card.calls.map((c) => c.name), ['write']);
  assert.equal(card.calls[0].arg, 'a.txt');
  assert.ok(card.git?.sha, '动手之前应该存过快照');

  // 网页端要知道自己能用 git，也要知道这一轮已经存过底
  assert.match(agent.prompt, /自动快照开着/);
  assert.match(agent.prompt, /git status/);
  assert.match(site.seen[1], /^【Git 快照】动手之前已自动存底 [0-9a-f]{7}/);
  assert.ok(site.seen[1].includes(card.git.sha.slice(0, 7)));

  const back = await agent.restore(card.id);
  assert.ok(back.ok, back.error);
  assert.equal(await fsp.readFile(path.join(workspace, 'a.txt'), 'utf8'), 'old');
});

test('没开 Git 快照时，restore 明确拒绝而不是乱动文件', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wa-agent-'));
  const workspace = path.join(dir, 'ws');
  await fsp.mkdir(workspace);
  await fsp.writeFile(path.join(workspace, 'a.txt'), 'old');

  const site = fakeSite([
    '```tool\nwrite {"path":"a.txt"}\nnew\n```\n改好了',
    '好了',
  ]);
  const agent = new Agent({ site, workspace, settings: { autoApprove: true, maxSteps: 3 } });
  t.after(async () => {
    agent.dispose();
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.rm(workspaceStateDir(workspace), { recursive: true, force: true });
  });

  await agent.send('改');
  const card = agent.timeline.find((x) => x.type === 'assistant');
  const back = await agent.restore(card.id);
  assert.equal(back.ok, false);
  assert.match(back.error, /Git/);
  assert.equal(await fsp.readFile(path.join(workspace, 'a.txt'), 'utf8'), 'new');
});
