// 原生的“选择文件夹”对话框。
// Windows 用 PowerShell 的 FolderBrowserDialog；其它平台没有统一实现，返回 null 让调用方退回手输。

import { spawn } from 'node:child_process';

function psQuote(text) {
  return `'${String(text).replace(/'/g, "''")}'`;
}

/** 打开系统文件夹选择框，返回绝对路径；用户取消返回 null。 */
export async function pickFolder({ title = '选择工程文件夹', initial = '' } = {}) {
  if (process.platform !== 'win32') return null;

  const script = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    `$d.Description = ${psQuote(title)}`,
    '$d.ShowNewFolderButton = $true',
    initial ? `$d.SelectedPath = ${psQuote(initial)}` : '',
    'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  [Console]::Out.Write($d.SelectedPath)',
    '}',
  ].join('\n');

  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const out = await new Promise((resolve) => {
    const child = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded,
    ], { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    child.stdout.on('data', (c) => { text += c.toString('utf8'); });
    child.stderr.on('data', () => {});
    child.on('error', () => resolve(''));
    child.on('exit', () => resolve(text));
  });

  const picked = out.trim();
  return picked || null;
}
