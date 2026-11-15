// 采集本机环境：系统、shell、Node、Python。
// 只用来给提示词补事实（哪个系统、命令怎么写、Python 是哪个版本），
// 检测一次就缓存，失败一律降级成“没找到”，不影响启动。

import os from 'node:os';
import { spawnSync } from 'node:child_process';

const isWin = process.platform === 'win32';

function pythonVersion() {
  const candidates = isWin
    ? [['python', ['--version']], ['py', ['-3', '--version']], ['python3', ['--version']]]
    : [['python3', ['--version']], ['python', ['--version']]];
  for (const [command, args] of candidates) {
    try {
      const r = spawnSync(command, args, { encoding: 'utf8', timeout: 4000, windowsHide: true });
      const text = `${r.stdout || ''}${r.stderr || ''}`;
      const m = text.match(/Python (\d+\.\d+\.\d+)/i);
      if (r.status === 0 && m) return { command, version: m[1] };
    } catch {
      // 没装、没权限、版本太老：换下一个候选
    }
  }
  return null;
}

function windowsName(release) {
  const build = Number(String(release).split('.')[2] || 0);
  return build >= 22000 ? 'Windows 11' : 'Windows 10';
}

let cached = null;

/** 返回 { platform, osLabel, release, arch, shell, pathSep, node, python }。 */
export function detectEnv() {
  if (cached) return cached;
  const platform = isWin ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
  const release = os.release();
  cached = {
    platform,
    osLabel: platform === 'windows' ? windowsName(release) : platform === 'macos' ? 'macOS' : 'Linux',
    release,
    arch: os.arch(),
    shell: isWin ? 'PowerShell' : 'bash',
    pathSep: isWin ? '\\' : '/',
    node: process.versions.node,
    python: pythonVersion(),
  };
  return cached;
}
