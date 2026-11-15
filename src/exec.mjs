// 跑命令。Windows 用 Windows PowerShell 5.1（系统自带），其它平台用 bash。
// 编码：脚本写成 UTF-8 BOM，脚本里把控制台输出改成 UTF-8，Node 再按 UTF-8 解码。
// 输出走临时文件、不接管道：后台进程会继承管道句柄，句柄不关管道就读不到 EOF，
// close 永远不触发，命令看起来就像卡死（uvicorn 那类命令的典型症状）。

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const isWin = process.platform === 'win32';

function killTree(pid) {
  if (!pid) return;
  try {
    if (isWin) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-pid, 'SIGKILL');
  } catch { /* 已经退出 */ }
}

/**
 * @param {string} command
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, timedOut:boolean, ms:number}>}
 */
export async function runShell(command, { cwd, timeoutMs = 120_000 } = {}) {
  const started = Date.now();
  const stamp = `web-agent-${process.pid}-${Date.now()}`;
  const tmp = path.join(os.tmpdir(), `${stamp}.${isWin ? 'ps1' : 'sh'}`);
  const outFile = path.join(os.tmpdir(), `${stamp}.out`);
  const errFile = path.join(os.tmpdir(), `${stamp}.err`);

  let script = command;
  if (isWin) {
    script = [
      '$ErrorActionPreference = "Continue"',
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      '$OutputEncoding = [System.Text.Encoding]::UTF8',
      '$ProgressPreference = "SilentlyContinue"',
      command,
    ].join('\r\n');
    await fsp.writeFile(tmp, '\uFEFF' + script, 'utf8');
  } else {
    await fsp.writeFile(tmp, command, 'utf8');
  }

  const bin = isWin ? 'powershell.exe' : '/bin/bash';
  const args = isWin
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmp]
    : [tmp];

  const out = fs.openSync(outFile, 'w');
  const err = fs.openSync(errFile, 'w');

  return await new Promise((resolve) => {
    let timedOut = false;
    let settled = false;
    let timer = null;

    const finish = (code, extra = '') => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      let stdout = '';
      let stderr = '';
      try { stdout = fs.readFileSync(outFile, 'utf8'); } catch { /* 没写出来 */ }
      try { stderr = fs.readFileSync(errFile, 'utf8'); } catch { /* 没写出来 */ }
      try { fs.closeSync(out); } catch { /* 已关 */ }
      try { fs.closeSync(err); } catch { /* 已关 */ }
      for (const f of [tmp, outFile, errFile]) fsp.rm(f, { force: true }).catch(() => {});
      // PowerShell 5.1 偶尔会在输出前后塞 BOM / CLIXML
      stdout = stdout.replace(/^\uFEFF/, '').replace(/^#< CLIXML\r?\n/, '');
      stderr = stderr.replace(/^\uFEFF/, '');
      resolve({
        code,
        stdout,
        stderr: extra ? `${stderr}\n${extra}`.trim() : stderr,
        timedOut,
        ms: Date.now() - started,
      });
    };

    let child;
    try {
      child = spawn(bin, args, {
        cwd,
        windowsHide: true,
        detached: !isWin,
        stdio: ['ignore', out, err],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', NO_COLOR: '1' },
      });
    } catch (e) {
      finish(null, e.message);
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      killTree(isWin ? child.pid : -child.pid);
      // taskkill 之后 close 一般会来；万一进程树里有卡住的，别让界面一直等。
      setTimeout(() => finish(null, `超过 ${Math.round(timeoutMs / 1000)} 秒还没结束，已终止。`), 1500);
    }, timeoutMs);

    child.on('error', (e) => finish(null, e.message));
    child.on('close', (code) => finish(code));
  });
}

export function which(cmd) {
  const finder = isWin ? 'where' : 'which';
  const r = spawnSync(finder, [cmd], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

export function pathExists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}
