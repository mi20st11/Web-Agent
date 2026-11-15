import test from 'node:test';
import assert from 'node:assert/strict';
import { runShell } from '../src/exec.mjs';

const isWin = process.platform === 'win32';

test('普通命令能拿到输出和退出码', async () => {
  const r = await runShell(isWin ? 'Write-Output hello' : 'echo hello', {
    cwd: process.cwd(),
    timeoutMs: 20_000,
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /hello/);
  assert.equal(r.timedOut, false);
});

// 后台进程会继承 shell 的 stdout 句柄；以前用管道接输出时读不到 EOF，
// 命令会一直挂到超时（uvicorn 那种起服务的命令就卡在这）。
test('后台子进程不会把 shell 卡到超时', async () => {
  const cmd = isWin
    ? 'Start-Process -FilePath cmd.exe -ArgumentList "/c","ping -n 6 127.0.0.1 > nul" -PassThru | Out-Null; "started"'
    : 'sleep 20 & echo started';
  const started = Date.now();
  const r = await runShell(cmd, { cwd: process.cwd(), timeoutMs: 90_000 });
  const ms = Date.now() - started;
  assert.equal(r.timedOut, false, '不该走到超时');
  assert.match(r.stdout, /started/);
  assert.ok(ms < 20_000, `应该几秒内返回，实际 ${ms}ms`);
});

test('超时会终止并标记 timedOut', async () => {
  const r = await runShell(isWin ? 'Start-Sleep -Seconds 30' : 'sleep 30', {
    cwd: process.cwd(),
    timeoutMs: 1500,
  });
  assert.equal(r.timedOut, true);
  assert.ok(r.ms < 30_000);
});
