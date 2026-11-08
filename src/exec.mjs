// 跑命令。Windows 用 Windows PowerShell 5.1（系统自带），其它平台用 bash。
// 编码：脚本写成 UTF-8 BOM，脚本里把控制台输出改成 UTF-8，Node 再按 UTF-8 解码。

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
  const tmp = path.join(os.tmpdir(), `web-agent-${process.pid}-${Date.now()}.${isWin ? 'ps1' : 'sh'}`);
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

  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn(bin, args, {
      cwd,
      windowsHide: true,
      detached: !isWin,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', NO_COLOR: '1' },
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(isWin ? child.pid : -child.pid);
    }, timeoutMs);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d) => { if (stdout.length < 2_000_000) stdout += d; });
    child.stderr?.on('data', (d) => { if (stderr.length < 2_000_000) stderr += d; });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}\n${err.message}`, timedOut, ms: Date.now() - started });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      fsp.rm(tmp, { force: true }).catch(() => {});
      // PowerShell 5.1 偶尔会在输出前后塞 CLIXML / 控制序列
      stdout = stdout.replace(/^#< CLIXML\r?\n/, '');
      resolve({ code, stdout, stderr, timedOut, ms: Date.now() - started });
    });
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
