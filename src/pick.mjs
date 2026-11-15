// 原生的“选择文件夹”对话框。
// Windows 用 PowerShell 的 FolderBrowserDialog；其它平台没有统一实现，返回 null 让调用方退回手输。

import { spawn } from 'node:child_process';

function psQuote(text) {
  return `'${String(text).replace(/'/g, "''")}'`;
}

/**
 * 打开系统文件夹选择框，返回绝对路径；用户取消返回 null。
 *
 * 对话框默认会开在浏览器窗口后面（浏览器是另一个进程，抢不到前台）。
 * 这里先建一个透明、置顶、不占任务栏的属主窗体，再让对话框以它为 Owner，
 * 弹出来就一定在最上面，用户不会以为“点了没反应”。
 */
export async function pickFolder({ title = '选择工程文件夹', initial = '' } = {}) {
  if (process.platform !== 'win32') return null;

  const script = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    'Add-Type -AssemblyName System.Drawing | Out-Null',
    '$owner = New-Object System.Windows.Forms.Form',
    `$owner.Text = ${psQuote('Web Agent')}`,
    '$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None',
    '$owner.ShowInTaskbar = $false',
    '$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen',
    '$owner.Size = New-Object System.Drawing.Size(1, 1)',
    '$owner.Opacity = 0',
    '$owner.TopMost = $true',
    '$owner.Show()',
    '$owner.Activate()',
    '[System.Windows.Forms.Application]::DoEvents()',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    `$d.Description = ${psQuote(title)}`,
    '$d.ShowNewFolderButton = $true',
    initial ? `$d.SelectedPath = ${psQuote(initial)}` : '',
    '$r = $d.ShowDialog($owner)',
    'if ($r -eq [System.Windows.Forms.DialogResult]::OK) {',
    // 输出走 base64：没有控制台的进程里 PowerShell 的控制台编码是系统 ANSI（中文机器上是 GBK），
    // 直接写中文路径会变成 UTF-8 解不出来的乱码，stat 失败就成了“不是文件夹”。
    '  [Console]::Out.Write([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($d.SelectedPath)))',
    '}',
    '$owner.Close()',
  ].filter(Boolean).join('\n');

  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const out = await new Promise((resolve) => {
    const child = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded,
    ], { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    child.stdout.on('data', (c) => { text += c.toString('utf8'); });
    child.stderr.on('data', () => {});
    child.on('error', () => resolve(''));
    // close 而不是 exit：exit 可能早于最后一段 stdout 读进来，路径会被截断。
    child.on('close', () => resolve(text));
  });

  const picked = Buffer.from(out.trim(), 'base64').toString('utf8').trim();
  return picked || null;
}
