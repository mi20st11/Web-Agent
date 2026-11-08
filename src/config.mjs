// 记住上次用过的工程目录。放在 ~/.web-agent/config.json，和浏览器 profile 分开。

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const FILE = path.join(os.homedir(), '.web-agent', 'config.json');

/**
 * 每个工程目录的运行数据放在这里：备份、工具输出、调用记录。
 * 故意不放进工程目录——用户的仓库里不该多出一个小文件夹。
 */
export function workspaceStateDir(workspace) {
  const root = process.env.WEB_AGENT_STATE_DIR
    || path.join(os.homedir(), '.web-agent', 'workspaces');
  const abs = path.resolve(workspace);
  const name = path.basename(abs).replace(/[^\w.-]+/g, '-').slice(0, 24) || 'workspace';
  const hash = createHash('sha1').update(process.platform === 'win32' ? abs.toLowerCase() : abs)
    .digest('hex').slice(0, 8);
  return path.join(root, `${name}-${hash}`);
}

export function configFile() {
  return FILE;
}

export async function loadConfig() {
  try {
    const raw = await fsp.readFile(FILE, 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

export async function saveConfig(patch) {
  const current = await loadConfig();
  const next = { ...current, ...patch };
  await fsp.mkdir(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
  await fsp.rename(tmp, FILE);
  return next;
}

/** 记录一次选择，顺便维护最近用过的几个目录。 */
export async function rememberWorkspace(dir) {
  const abs = path.resolve(dir);
  const current = await loadConfig();
  const recent = [abs, ...(Array.isArray(current.recent) ? current.recent : []).filter((x) => x !== abs)]
    .slice(0, 6);
  await saveConfig({ lastWorkspace: abs, recent });
  return recent;
}

export async function recentWorkspaces() {
  const current = await loadConfig();
  return Array.isArray(current.recent) ? current.recent : [];
}

/**
 * 0.2 及以前把 backups/out/log.jsonl 写在 <工作区>/.web-agent 里。
 * 换目录时如果发现这种旧目录（且没有用户自己的 instructions.md），
 * 把运行数据挪到新的状态目录，再把这个文件夹删掉，工程目录恢复干净。
 */
export async function absorbLegacyState(workspace) {
  const legacy = path.join(path.resolve(workspace), '.web-agent');
  let names = [];
  try {
    names = await fsp.readdir(legacy);
  } catch {
    return false;
  }
  const ours = new Set(['backups', 'out', 'log.jsonl']);
  if (names.some((n) => !ours.has(n) && n !== 'instructions.md')) return false;

  const target = workspaceStateDir(workspace);
  await fsp.mkdir(target, { recursive: true });
  for (const name of names) {
    if (!ours.has(name)) continue;
    const from = path.join(legacy, name);
    const to = path.join(target, name);
    if (await fsp.stat(to).then(() => true).catch(() => false)) continue;
    // 工程可能在另一个盘，rename 跨盘会失败，复制后再删
    try {
      await fsp.cp(from, to, { recursive: true, force: false, errorOnExist: true });
      await fsp.rm(from, { recursive: true, force: true });
    } catch { /* 挪不动就留着，不动用户数据 */ }
  }
  // instructions.md 是用户自己写的，留着；没有它就把空目录清掉
  if (!names.includes('instructions.md')) {
    await fsp.rm(legacy, { recursive: true, force: true }).catch(() => {});
  }
  return true;
}

/** 正在运行的实例：端口、地址、浏览器。用来挡住重复启动。 */
export function instanceFile() {
  return path.join(path.dirname(FILE), 'instance.json');
}

export async function readInstance() {
  try {
    const raw = await fsp.readFile(instanceFile(), 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

export async function writeInstance(data) {
  const body = JSON.stringify({ ...data, pid: process.pid, startedAt: Date.now() }, null, 2);
  const file = instanceFile();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, body, 'utf8');
}

export async function clearInstance() {
  try {
    const data = await readInstance();
    if (data && data.pid !== process.pid) return; // 别人的锁，别动
    await fsp.unlink(instanceFile());
  } catch { /* 已经没了 */ }
}
