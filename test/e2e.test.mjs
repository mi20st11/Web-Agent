import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { attachPage, launchBrowser } from '../src/browser.mjs';
import { DeepSeekSite } from '../src/site.mjs';
import { createPolicy } from '../src/policy.mjs';
import { workspaceStateDir } from '../src/config.mjs';
import { Agent } from '../src/agent.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch { /* 已退出 */ }
}

async function cleanup(dir) {
  for (let i = 0; i < 5; i += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

async function boot(t, settings = {}) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-e2e-ws-'));
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-e2e-prof-'));
  const mockUrl = pathToFileURL(path.join(here, 'mock-deepseek.html')).href;

  const launched = await launchBrowser({
    profileDir: profile,
    url: mockUrl,
    headless: true,
    timeoutMs: 60_000,
  });
  const cdp = await attachPage(launched.port, { urlIncludes: 'mock-deepseek', timeoutMs: 30_000 });
  assert.ok(cdp, '应该能连上 mock 页面');

  const site = new DeepSeekSite(cdp, { url: mockUrl });
  // 运行数据落在工作区之外，测试里指到临时目录，结束后一起删
  const stateDir = workspaceStateDir(workspace);
  const policy = createPolicy({
    workspace,
    logFile: path.join(stateDir, 'log.jsonl'),
    backupDir: path.join(stateDir, 'backups'),
  });
  const agent = new Agent({
    site,
    policy,
    workspace,
    outDir: path.join(stateDir, 'out'),
    settings: { autoApprove: true, maxSteps: 5, replyTimeoutMs: 90_000, ...settings },
  });

  t.after(async () => {
    try { agent.dispose(); } catch { /* 忽略 */ }
    try { cdp.close(); } catch { /* 忽略 */ }
    killTree(launched.proc?.pid);
    await cleanup(profile);
    await cleanup(workspace);
    await cleanup(stateDir);
  });

  const status = await agent.site.waitReady({ timeoutMs: 30_000 });
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.equal(status.signedOut, false);
  return { workspace, stateDir, agent };
}

async function waitPending(agent, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const p = agent.snapshot().pending;
    if (p) return p;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('等待审批超时');
}

test('端到端：mock DeepSeek → 解析工具 → 写文件 → 回传结果', { timeout: 180_000 }, async (t) => {
  const { workspace, stateDir, agent } = await boot(t);

  const result = await agent.send('帮我写文件');
  assert.equal(result.ok, true, result.error);

  const written = await fs.readFile(path.join(workspace, 'hello.txt'), 'utf8');
  assert.match(written, /你好，Web Agent/);

  const state = agent.snapshot();
  assert.equal(state.busy, false);
  const tools = state.timeline.filter((x) => x.type === 'tool');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'write');
  assert.equal(tools[0].status, 'done');

  const assistants = state.timeline.filter((x) => x.type === 'assistant');
  assert.ok(assistants.length >= 2, '至少两轮回答：工具调用 + 最终答复');
  assert.match(assistants.at(-1).text, /已经写进工作区/);

  // 工程目录里不该出现 .web-agent
  await assert.rejects(fs.stat(path.join(workspace, '.web-agent')));
  const log = await fs.readFile(path.join(stateDir, 'log.jsonl'), 'utf8');
  assert.match(log, /"name":"write"/);
});

test('端到端：危险命令进审批，拒绝后不执行', { timeout: 180_000 }, async (t) => {
  const { agent } = await boot(t, { autoApprove: false });

  const running = agent.send('来个危险命令测试');
  const pending = await waitPending(agent);
  assert.equal(pending.kind, 'approval');
  assert.match(pending.detail, /Remove-Item/);

  agent.respond({ id: pending.id, allow: false });
  const result = await running;
  assert.equal(result.ok, true, result.error);

  const state = agent.snapshot();
  assert.equal(state.pending, null);
  const shell = state.timeline.find((x) => x.type === 'tool');
  assert.equal(shell.status, 'error');
  assert.match(shell.output, /用户拒绝/);
});
