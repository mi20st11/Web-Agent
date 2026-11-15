// 浏览器管理：找一个 Chromium 内核浏览器，用独立 profile 启动并打开调试端口。
// 关键事实（Chrome 136+）：默认 profile 会静默忽略 --remote-debugging-port，
// 必须给独立 --user-data-dir；端口用 0 让系统分配，再从 profile 里的
// DevToolsActivePort 文件读回来（第一行端口，第二行 browser ws 路径）。

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CDP } from './cdp.mjs';

export const DEEPSEEK_URL = 'https://chat.deepseek.com/';
export const GEMINI_URL = 'https://gemini.google.com/app';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function defaultProfileDir(browser = 'edge') {
  const dir = browser === 'chrome' ? 'chrome-profile' : 'browser-profile';
  return path.join(os.homedir(), '.web-agent', dir);
}

/** 从可执行文件路径判断是哪个浏览器。 */
export function browserName(exePath) {
  return /chrome/i.test(path.basename(exePath)) ? 'chrome' : 'edge';
}

function candidates() {
  const win = [];
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pfx86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local');
    win.push(
      { name: 'edge', path: path.join(pfx86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
      { name: 'edge', path: path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
      { name: 'edge', path: path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
      { name: 'chrome', path: path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { name: 'chrome', path: path.join(pfx86, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { name: 'chrome', path: path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    );
    return win;
  }
  if (process.platform === 'darwin') {
    return [
      { name: 'edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
      { name: 'chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
      { name: 'chrome', path: '/Applications/Chromium.app/Contents/MacOS/Chromium' },
    ];
  }
  return [
    { name: 'edge', path: '/usr/bin/microsoft-edge' },
    { name: 'chrome', path: '/usr/bin/google-chrome' },
    { name: 'chrome', path: '/usr/bin/google-chrome-stable' },
    { name: 'chrome', path: '/usr/bin/chromium' },
    { name: 'chrome', path: '/usr/bin/chromium-browser' },
    { name: 'chrome', path: '/snap/bin/chromium' },
  ];
}

/**
 * 找浏览器。--browser 可以传 edge / chrome / 完整路径。
 * 环境变量 WEB_AGENT_BROWSER 也可以指定完整路径。
 */
export function findBrowser(explicit) {
  const wanted = explicit && /^(edge|chrome)$/i.test(explicit) ? explicit.toLowerCase() : '';
  if (explicit && !wanted) {
    if (!fs.existsSync(explicit)) throw new Error(`指定的浏览器不存在：${explicit}`);
    return explicit;
  }
  if (!explicit && process.env.WEB_AGENT_BROWSER) {
    const fromEnv = process.env.WEB_AGENT_BROWSER;
    if (!fs.existsSync(fromEnv)) throw new Error(`WEB_AGENT_BROWSER 指向的文件不存在：${fromEnv}`);
    return fromEnv;
  }

  const list = candidates();
  const pool = wanted ? list.filter((b) => b.name === wanted) : list;
  const found = pool.find((b) => fs.existsSync(b.path));
  if (!found) {
    throw new Error(
      wanted
        ? `没找到 ${wanted}。可以装一个，或用 --browser "完整路径" 指定。`
        : '没找到 Chrome / Edge。装一个，或用 --browser edge|chrome|"完整路径" 指定。',
    );
  }
  return found.path;
}

export async function readPortFile(profileDir) {
  try {
    const raw = await fsp.readFile(path.join(profileDir, 'DevToolsActivePort'), 'utf8');
    const [portLine, wsPath] = raw.split(/\r?\n/);
    const port = Number(portLine);
    if (!Number.isInteger(port) || port <= 0) return null;
    return { port, wsPath: wsPath?.trim() || '' };
  } catch {
    return null;
  }
}

/** 端口是否真的在说 DevTools 协议（而不是被别的程序占用）。 */
export async function listPages(port, { timeoutMs = 1500 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = await res.json();
    return Array.isArray(body) ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 启动（或复用）一个带调试端口的浏览器。
 * @returns {Promise<{exe:string, profileDir:string, port:number, wsPath:string,
 *   proc:import('node:child_process').ChildProcess|null, spawned:boolean}>}
 */
export async function launchBrowser({
  exe, profileDir = defaultProfileDir(), url = DEEPSEEK_URL,
  headless = false, timeoutMs = 30_000, extraArgs = [],
} = {}) {
  exe = findBrowser(exe);
  profileDir = path.resolve(profileDir);
  await fsp.mkdir(profileDir, { recursive: true });

  const existing = await readPortFile(profileDir);
  if (existing && await listPages(existing.port)) {
    return { exe, profileDir, port: existing.port, wsPath: existing.wsPath, proc: null, spawned: false };
  }

  // 上次异常退出留下的端口文件不可信，删掉再启动。
  try { await fsp.rm(path.join(profileDir, 'DevToolsActivePort'), { force: true }); } catch {}

  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    // Edge 登录后会把账号里的“阻止所有 Cookie”同步过来，自动化 profile 一律关掉同步。
    '--disable-sync',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    ...(headless ? ['--headless=new', '--disable-gpu'] : []),
    ...extraArgs,
    url,
  ];
  const proc = spawn(exe, args, { stdio: 'ignore', windowsHide: false });
  proc.on('error', () => {});

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(250);
    const info = await readPortFile(profileDir);
    if (info && await listPages(info.port)) {
      return { exe, profileDir, port: info.port, wsPath: info.wsPath, proc, spawned: true };
    }
    if (proc.exitCode != null && proc.exitCode !== 0) {
      throw new Error(`浏览器启动失败（退出码 ${proc.exitCode}）。换个浏览器试试：--browser "路径"`);
    }
  }
  throw new Error('浏览器 30 秒内没有打开调试端口。可能是 profile 被占用，或浏览器版本太旧。');
}

/** 用同一个 profile 再开一个无地址栏应用窗口，作为本软件的界面。 */
export function openAppWindow({ exe, profileDir, url }) {
  const child = spawn(exe, [
    `--user-data-dir=${path.resolve(profileDir)}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--app=${url}`,
    '--window-size=1180,860',
  ], { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
  return child;
}

export async function attachPage(port, { urlIncludes = '', timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pages = await listPages(port);
    const page = pages?.find((p) => p.type === 'page' && (p.url || '').includes(urlIncludes));
    if (page?.webSocketDebuggerUrl) return CDP.connect(page.webSocketDebuggerUrl);
    await sleep(400);
  }
  return null;
}

/** 从 /json/version 拿 browser 级 ws 路径（--cdp 接入已有浏览器时用）。 */
export async function browserWsPath(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return '';
    const info = await res.json();
    const ws = info.webSocketDebuggerUrl || '';
    return ws ? new URL(ws).pathname : '';
  } catch {
    return '';
  }
}

/** 在已有浏览器里新开标签页（走 browser 级 CDP，比 /json/new 稳）。 */
/** 把预热时藏在屏幕外的窗口搬回正常位置（只在换到预热过的浏览器时调用）。 */
export async function revealWindow({ port, wsPath, urlIncludes = '', left = 90, top = 80, force = false }) {
  const browser = await CDP.connect(`ws://127.0.0.1:${port}${wsPath}`, { timeoutMs: 5000 }).catch(() => null);
  if (!browser) return false;
  try {
    const { targetInfos } = await browser.send('Target.getTargets');
    const page = targetInfos?.find((t) => t.type === 'page' && (t.url || '').includes(urlIncludes));
    if (!page) return false;
    const { windowId } = await browser.send('Browser.getWindowForTarget', { targetId: page.targetId });
    const { bounds } = await browser.send('Browser.getWindowBounds', { windowId }).catch(() => ({ bounds: null }));
    // 最小化的窗口：恢复成普通窗口并摆回屏幕上（最小化时点任务栏也看不见东西）。
    if (bounds?.windowState === 'minimized') {
      await browser.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => {});
      await browser.send('Browser.setWindowBounds', { windowId, bounds: { left, top } }).catch(() => {});
      return true;
    }
    // 只搬藏在屏幕外的（预热窗口）；正常在屏上的窗口不动它。
    if (!force && bounds && bounds.left > -1000 && bounds.top > -1000) return false;
    await browser.send('Browser.setWindowBounds', { windowId, bounds: { left, top } });
    return true;
  } catch {
    return false;
  } finally {
    browser.close();
  }
}

/**
 * 把某个页面所在的窗口最小化（预热出来的浏览器用它：不占屏幕、任务栏点了还能回来）。
 */
export async function hideWindow({ port, wsPath, urlIncludes = '' }) {
  const browser = await CDP.connect(`ws://127.0.0.1:${port}${wsPath}`, { timeoutMs: 5000 }).catch(() => null);
  if (!browser) return false;
  try {
    const { targetInfos } = await browser.send('Target.getTargets');
    const page = targetInfos?.find((t) => t.type === 'page' && (t.url || '').includes(urlIncludes));
    if (!page) return false;
    const { windowId } = await browser.send('Browser.getWindowForTarget', { targetId: page.targetId });
    const { bounds } = await browser.send('Browser.getWindowBounds', { windowId }).catch(() => ({ bounds: null }));
    if (bounds?.windowState === 'minimized') return false;
    // 收起来就是最小化，不是挪到屏幕外：屏幕外的窗口在任务栏里点了不出现，
    // 用户会以为“打不开”；最小化的窗口点一下就回来。
    await browser.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    return true;
  } catch {
    return false;
  } finally {
    browser.close();
  }
}

export async function createTarget({ port, wsPath, url }) {
  if (!wsPath) throw new Error('缺少 browser ws 路径，无法新开标签页');
  const browser = await CDP.connect(`ws://127.0.0.1:${port}${wsPath}`);
  try {
    const { targetId } = await browser.send('Target.createTarget', { url });
    return targetId;
  } finally {
    browser.close();
  }
}

/** 把对话窗口切到前台，让用户看到登录页 / 对话。 */
export async function focusTarget({ port, wsPath, urlIncludes = '' }) {
  const pages = await listPages(port);
  const page = pages?.find((p) => (p.url || '').includes(urlIncludes));
  if (!page) return false;
  const browser = await CDP.connect(`ws://127.0.0.1:${port}${wsPath}`);
  try {
    await browser.send('Target.activateTarget', { targetId: page.id });
    return true;
  } finally {
    browser.close();
  }
}

/** 优雅关闭自己启动的浏览器：先 Browser.close，超时才强杀。 */
export async function closeBrowser({ port, wsPath, proc, timeoutMs = 6000 } = {}) {
  if (port && wsPath) {
    try {
      const cdp = await CDP.connect(`ws://127.0.0.1:${port}${wsPath}`, { timeoutMs: 3000 });
      await cdp.send('Browser.close', {}, { timeoutMs: 3000 }).catch(() => {});
      cdp.close();
    } catch { /* 已经关了 */ }
  }
  if (!proc || proc.exitCode !== null) return;
  const exited = await Promise.race([
    new Promise((r) => proc.once('exit', () => r(true))),
    sleep(timeoutMs).then(() => false),
  ]);
  if (exited) return;
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  } else {
    try { proc.kill('SIGTERM'); } catch {}
  }
}

/** 把应用界面窗口提到最前（切换浏览器后让用户一眼看到）。 */
export async function focusAppWindow({ port, url, timeoutMs = 5000 }) {
  const want = String(url || '').replace(/\/$/, '');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pages = await listPages(port).catch(() => null);
    const page = pages?.find((p) => p.type === 'page' && (p.url || '').startsWith(want));
    if (page?.webSocketDebuggerUrl) {
      const cdp = await CDP.connect(page.webSocketDebuggerUrl, { timeoutMs: 3000 }).catch(() => null);
      if (cdp) {
        await cdp.send('Page.bringToFront').catch(() => {});
        cdp.close();
        return true;
      }
    }
    await sleep(300);
  }
  return false;
}

/**
 * 同一个界面地址只留一个窗口。
 * Edge/Chrome 的 --app= 每次启动都新开一个，用户多点两下 exe 就会攒出
 * 两三个一模一样的「Web Agent」窗口，任务栏也分成好几个。
 */
export async function dedupeAppWindows({ port, wsPath, url }) {
  const browser = await CDP.connect(`ws://127.0.0.1:${port}${wsPath}`, { timeoutMs: 5000 }).catch(() => null);
  if (!browser) return 0;
  try {
    const { targetInfos } = await browser.send('Target.getTargets');
    // 只认这个工作台自己的界面窗口：地址是当前这个服务的，或标题就叫 Web Agent
    // （服务已经退掉的那些窗口标题还在，地址却打不开了）。保留一条，其余关掉。
    const mine = (t) => t.type === 'page'
      && ((t.url || '').startsWith(url) || t.title === 'Web Agent' || /^https?:\/\/127\.0\.0\.1:\d+\/?$/.test(t.url || ''));
    const pages = (targetInfos || []).filter(mine);
    pages.sort((a, b) => ((b.url || '').startsWith(url) ? 1 : 0) - ((a.url || '').startsWith(url) ? 1 : 0));
    for (const extra of pages.slice(1)) {
      await browser.send('Target.closeTarget', { targetId: extra.targetId }).catch(() => {});
    }
    return Math.max(0, pages.length - 1);
  } catch {
    return 0;
  } finally {
    browser.close();
  }
}
