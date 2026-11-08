// 安全策略：文件操作不许出工作区；危险命令要审批；覆盖前自动备份。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export class PolicyError extends Error {
  constructor(message, code = 'POLICY') {
    super(message);
    this.name = 'PolicyError';
    this.code = code;
  }
}

/** 命令命中这些模式就弹审批。宁可多问一句，也不要在用户机器上乱来。 */
const DANGEROUS = [
  { re: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+(\/|~|[a-z]:\\)/i, why: '递归删除根目录/家目录' },
  { re: /\b(del|erase)\s+\/[sfq]/i, why: '强制/静默删除' },
  { re: /\bformat\s+[a-z]:/i, why: '格式化磁盘' },
  { re: /\bdiskpart\b/i, why: '磁盘分区工具' },
  { re: /\b(bcdedit|bootrec|vssadmin)\b/i, why: '启动/卷影配置' },
  { re: /\breg\s+(delete|add)\b/i, why: '改注册表' },
  { re: /\b(shutdown|restart-computer|stop-computer)\b/i, why: '关机/重启' },
  { re: /\btakeown\b|\bicacls\b[^\n]*\/grant/i, why: '改文件所有权/权限' },
  { re: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*[fd])/i, why: '丢弃工作区改动' },
  { re: /\bRemove-Item\b[^\n]*-Recurse[^\n]*([a-z]:\\(?!.*(temp|tmp|node_modules))|\/(?!.*(tmp|temp)))/i, why: '递归删除目录' },
  { re: /\b(curl|wget|irm|iwr)\b[^\n]*\|\s*(ba|z)?sh\b/i, why: '下载后直接执行脚本' },
  { re: /\bInvoke-Expression\b|\biex\b/i, why: '动态执行字符串' },
  { re: />\s*[a-z]:\\(windows|program files)/i, why: '覆盖系统目录文件' },
];

export function isDangerous(command) {
  const text = String(command || '');
  for (const { re, why } of DANGEROUS) {
    if (re.test(text)) return { dangerous: true, reason: why };
  }
  return { dangerous: false };
}

export function createPolicy({ workspace, logFile, backupDir }) {
  const root = path.resolve(workspace);
  const rootReal = safeReal(root);
  const lower = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);

  function safeReal(p) {
    let cur = path.resolve(p);
    const tail = [];
    for (let i = 0; i < 100; i += 1) {
      if (fs.existsSync(cur)) {
        try {
          return path.join(fs.realpathSync.native(cur), ...tail);
        } catch {
          return path.join(cur, ...tail);
        }
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
    return path.resolve(p);
  }

  function resolveInside(input, { allowRoot = false } = {}) {
    if (!input || typeof input !== 'string') throw new PolicyError('缺少路径参数');
    const abs = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);
    const withLinks = safeReal(abs);
    const rootCmp = lower(rootReal);
    const absCmp = lower(withLinks);
    const inside = absCmp === rootCmp || absCmp.startsWith(rootCmp + path.sep);
    if (!inside) {
      throw new PolicyError(`路径在工作区外，已拒绝：${input}`);
    }
    if (!allowRoot && absCmp === rootCmp) {
      throw new PolicyError('这个操作需要具体文件路径，不能是工作区根目录');
    }
    return abs;
  }

  async function backup(abs) {
    if (!backupDir) return null;
    try {
      const st = await fsp.stat(abs);
      if (!st.isFile()) return null;
    } catch {
      return null; // 新文件，不用备份
    }
    const rel = path.relative(root, abs);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = path.join(backupDir, stamp, rel.replace(/[<>:"|?*]/g, '_'));
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(abs, dest);
    return dest;
  }

  async function log(entry) {
    if (!logFile) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    await fsp.mkdir(path.dirname(logFile), { recursive: true });
    await fsp.appendFile(logFile, line, 'utf8');
  }

  return {
    root,
    resolveInside,
    backup,
    log,
    isDangerous,
    relative: (abs) => path.relative(root, abs) || '.',
  };
}
