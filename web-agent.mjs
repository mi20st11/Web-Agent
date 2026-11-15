#!/usr/bin/env node
// Web Agent 入口：先把界面开起来，再在后台连浏览器和网页端对话。
// 工程目录可以在界面里选，选完会记住，下次直接进来。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DEEPSEEK_URL, GEMINI_URL, attachPage, browserName, browserWsPath, closeBrowser, createTarget, defaultProfileDir, dedupeAppWindows, findBrowser,
  focusAppWindow, focusTarget, hideWindow, launchBrowser, listPages, openAppWindow, readPortFile, revealWindow,
} from './src/browser.mjs';
import { DeepSeekSite } from './src/site.mjs';
import { GeminiSite } from './src/gemini.mjs';
import { Agent } from './src/agent.mjs';
import { startServer } from './src/server.mjs';
import { absorbLegacyState, clearInstance, loadConfig, readInstance, saveConfig, writeInstance } from './src/config.mjs';
import { openLog, teeConsole } from './src/log.mjs';

// 从 exe（无控制台）启动时 stdout/stderr 可能不可写，写失败不能把进程带走。
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const VERSION = '0.3.0';

/** 支持的网页对话站点。加新站点只要在这里补一项 + 一个适配文件。 */
const SITES = {
  deepseek: {
    label: 'DeepSeek',
    url: DEEPSEEK_URL,
    match: 'chat.deepseek.com',
    create: (cdp, opts) => new DeepSeekSite(cdp, opts),
  },
  gemini: {
    label: 'Gemini',
    url: GEMINI_URL,
    match: 'gemini.google.com',
    create: (cdp, opts) => new GeminiSite(cdp, opts),
  },
};

function parseArgs(argv) {
  const opts = {
    workspace: '',
    workspaceGiven: false,
    port: 0,
    browser: '',
    profile: '',
    window: true,
    keepBrowser: false,
    noRecover: false,
    force: false,
    auto: false,
    headless: false,
    cdp: 0,
    site: '',
    url: '',
    urlGiven: false,
    match: '',
    maxSteps: 30,
  };
  const argvList = [...argv];
  const take = (i) => {
    const v = argvList[i];
    if (v == null || v.startsWith('--')) throw new Error(`参数缺少值：${argvList[i - 1]}`);
    return v;
  };
  for (let i = 0; i < argvList.length; i += 1) {
    let a = argvList[i];
    let inline = null;
    if (a.startsWith('--') && a.includes('=')) {
      const idx = a.indexOf('=');
      inline = a.slice(idx + 1);
      a = a.slice(0, idx);
    }
    const value = () => (inline != null ? inline : take(++i));
    switch (a) {
      case '--workspace': case '-w': opts.workspace = value(); opts.workspaceGiven = true; break;
      case '--port': opts.port = Number(value()); break;
      case '--browser': opts.browser = value(); break;
      case '--profile': opts.profile = value(); break;
      case '--no-window': opts.window = false; break;
      case '--no-pick': opts.pick = false; break; // 兼容旧参数，现在不再弹启动框
      case '--keep-browser': opts.keepBrowser = true; break;
      case '--no-recover': opts.noRecover = true; break;
      case '--force': opts.force = true; break;
      case '--auto': opts.auto = true; break;
      case '--headless': opts.headless = true; opts.window = false; break;
      case '--cdp': opts.cdp = Number(value()); break;
      case '--site': opts.site = value(); break;
      case '--url': opts.url = value(); opts.urlGiven = true; break;
      case '--match': opts.match = value(); break;
      case '--max-steps': opts.maxSteps = Number(value()); break;
      case '--help': case '-h': opts.help = true; break;
      case '--version': opts.version = true; break;
      default:
        if (a.startsWith('-')) throw new Error(`不认识的参数：${a}`);
        opts.workspace = a;
        opts.workspaceGiven = true;
    }
  }
  return opts;
}

function help() {
  console.log(`Web Agent ${VERSION} — 用网页版 AI 当本机编程助手

用法：
  node web-agent.mjs [选项]

选项：
  -w, --workspace <dir>   直接指定工程目录（不给就在界面里选，会记住上次的）
      --port <n>          本地界面端口（默认随机）
      --site <名字>       网页端：deepseek（默认）或 gemini，会记住上次的选择
      --browser <名字>    默认用 edge 还是 chrome（进界面后也能换），也可以给可执行文件路径
      --profile <dir>     浏览器 profile 目录（默认按浏览器分开存）
      --auto              自动批准危险命令（默认关闭）
      --no-window         不自动打开应用窗口
      --keep-browser      退出时保留浏览器
      --no-recover        浏览器关掉后不自动重开
      --force             忽略单实例检查，再开一个独立实例
      --headless          无头浏览器，仅调试用
      --cdp <port>        接入已有的调试端口，不自己启动浏览器
      --url <url>         覆盖站点地址（测试用）
      --match <substr>    用 URL 片段找页面（测试用）
  -h, --help              显示帮助

首次运行：先在界面里选一个工程目录，再到打开的对话窗口里登录一次。
登录态存在独立 profile 里，之后启动直接可用。`);
}

/**
 * 界面已经在跑时，把那个窗口摆到前面 —— 不能再开一个。
 * Edge/Chrome 的 --app= 每次启动都新开窗口，用户多点两下 exe 就会攒出一排
 * 一模一样的「Web Agent」，所以这里先聚焦，顺手关掉重复的。
 */
async function focusExistingApp({ profileDir, url }) {
  const info = await readPortFile(profileDir).catch(() => null);
  if (!info?.port) return false;
  const ok = await focusAppWindow({ port: info.port, url }).catch(() => false);
  if (!ok) return false;
  await dedupeAppWindows({ port: info.port, wsPath: info.wsPath, url }).catch(() => {});
  await revealWindow({ port: info.port, wsPath: info.wsPath, urlIncludes: url, left: 10, top: 10 }).catch(() => {});
  return true;
}

async function main() {
  const log = openLog();
  teeConsole(log);
  console.log(`argv ${process.argv.slice(2).join(' ') || '（无参数）'}`);

  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { help(); return; }
  if (opts.version) { console.log(VERSION); return; }

  // 站点优先级：--site > --url 推断 > 上次用的 > deepseek
  const early = await loadConfig();
  const inferred = opts.urlGiven
    ? (/gemini\.google\.com/.test(opts.url) ? 'gemini'
      : /deepseek\.com/.test(opts.url) ? 'deepseek' : '')
    : '';
  let siteKey = String(opts.site || inferred || early.site || 'deepseek').toLowerCase();
  let siteDef = SITES[siteKey];
  if (!siteDef) throw new Error(`不认识的网页端：${siteKey}（支持 ${Object.keys(SITES).join(' / ')}）`);
  if (!opts.urlGiven) opts.url = siteDef.url;
  opts.site = siteKey;
  let siteUrl = opts.url; // 运行时可以换成另一个网页端，连接一律用这个

  // 工作区优先级：命令行 > 上次用过的 > 先空着（界面里选）
  let workspace = null;
  if (opts.workspaceGiven) {
    const abs = path.resolve(opts.workspace);
    const st = fs.statSync(abs, { throwIfNoEntry: false });
    if (!st?.isDirectory()) throw new Error(`工作区不是目录：${abs}`);
    workspace = abs;
  } else {
    const cfg = await loadConfig();
    const last = cfg.lastWorkspace;
    const st = last ? fs.statSync(last, { throwIfNoEntry: false }) : null;
    if (st?.isDirectory()) workspace = last;
  }

  // 旧版本在工程里留下的 .web-agent（只含运行数据）搬走后清掉
  if (workspace) await absorbLegacyState(workspace).catch(() => {});
  const instructionsFile = workspace ? path.join(workspace, '.web-agent', 'instructions.md') : '';
  const instructions = instructionsFile && fs.existsSync(instructionsFile)
    ? fs.readFileSync(instructionsFile, 'utf8').trim()
    : '';

  // 浏览器先定位好，界面可以先开，连接在后台慢慢来。
  // 用户可以在界面里换浏览器；换的时候会关掉当前窗口，用新 profile 重连。
  const stored = await loadConfig();
  const info = {
    name: '',
    exe: '',
    profileDir: '',
    canSwitch: !opts.cdp && !opts.profile,
    switching: false,
  };
  if (!opts.cdp) {
    try {
      info.exe = findBrowser(opts.browser || stored.browser || 'edge');
    } catch (err) {
      // 上次选的浏览器被卸载了：退回 Edge，别在启动时卡死
      if (opts.browser || !stored.browser) throw err;
      info.exe = findBrowser('edge');
    }
    info.name = browserName(info.exe);
    info.profileDir = opts.profile
      ? path.resolve(opts.profile)
      : defaultProfileDir(info.name);
  }

  // 连接完成前先用一个占位站点，界面照样能打开、选目录
  const placeholder = {
    name: siteDef.label,
    async check() {
      return { ok: false, signedOut: false, hasEditor: false, storageBlocked: false, url: '', title: '' };
    },
    async ask() { throw new Error(`还没连上 ${siteDef.label}`); },
    async stop() {},
    async newChat() { return false; },
    async focus() { return false; },
  };

  if (opts.browser && info.name) await saveConfig({ browser: info.name }).catch(() => {});
  await saveConfig({ site: siteKey }).catch(() => {});

  const agent = new Agent({
    site: placeholder,
    workspace,
    settings: {
      autoApprove: opts.auto,
      maxSteps: opts.maxSteps,
      instructions,
      gitEnabled: Boolean(stored.gitEnabled),
      promptProfile: stored.promptProfile || 'auto',
    },
  });
  const savedConfig = stored;
  // 只列还存在的目录：删掉的工程不该留在“最近用过”里点出错
  agent.recent = (Array.isArray(savedConfig.recent) ? savedConfig.recent : [])
    .filter((p) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory());

  // 打包成单 exe 后没有模块路径，界面 HTML 已经内联，uiDir 只作兜底。
  let here = process.cwd();
  try { here = path.dirname(fileURLToPath(import.meta.url)); } catch { /* 单 exe 环境 */ }
  const uiDir = path.join(here, 'ui');
  // opened 记着这次运行里起过的所有浏览器，换浏览器时旧的留着不关，退出时一起收。
  const runtime = { launched: null, port: 0, wsPath: '', match: '', opened: [], switching: false };
  let uiWindowPort = 0; // 界面窗口开在哪个调试端口上，换浏览器时不再另开
  let warmStarted = false; // 另一个浏览器只预热一次

  const browserState = () => ({
    name: info.name,
    profileDir: info.profileDir,
    canSwitch: info.canSwitch,
    switching: info.switching,
  });

  // 同一时间只跑一个：第二次启动把已有界面调出来，避免两个实例抢同一个浏览器 profile
  if (!opts.force) {
    const prev = await readInstance().catch(() => null);
    if (prev?.pid && prev.url && prev.version === VERSION) {
      let alive = await fetch(`${prev.url}api/health`, { signal: AbortSignal.timeout(1500) })
        .then((r) => (r.ok ? r.json() : null)).catch(() => null);
      // 界面还活着但浏览器已经断开（用户关了对话窗口、Chrome 崩了）时，不能只是把界面调出来：
      // 那样既没有对话窗口，也没有模型列表，看起来就是“打开没反应”。接管它，重开浏览器。
      if (alive && alive.connection !== 'ready') {
        await new Promise((r) => setTimeout(r, 1500));
        const again = await fetch(`${prev.url}api/health`, { signal: AbortSignal.timeout(1500) })
          .then((r) => (r.ok ? r.json() : null)).catch(() => null);
        if (again && again.connection === 'ready') {
          alive = again;
        } else {
          console.log(`\n  上一个实例的浏览器已经断开（界面还占着 ${prev.url}），正在接管…`);
          try { spawnSync('taskkill', ['/PID', String(prev.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已经退出 */ }
          await clearInstance().catch(() => {});
          alive = null;
        }
      }
      if (alive) {
        const prevName = prev.browser || info.name;
        const prevExe = opts.cdp ? '' : (() => { try { return findBrowser(prevName); } catch { return ''; } })();
        const prevDir = prev.profileDir || (prevExe ? defaultProfileDir(browserName(prevExe)) : '');
        if (opts.window && !opts.headless && prevExe && prevDir) {
          const shown = await focusExistingApp({ profileDir: prevDir, url: prev.url });
          if (!shown) openAppWindow({ exe: prevExe, profileDir: prevDir, url: prev.url });
        }
        console.log(`\n  Web Agent 已经在跑：${prev.url}`);
        console.log('  已经把这个界面调出来了。要再开一个独立实例，加 --force。\n');
        return;
      }
    }
  }

  let uiHtml = null;
  try {
    ({ UI_HTML: uiHtml } = await import('./src/ui-asset.mjs'));
  } catch {
    // 源码运行时没有这个文件，照常从 ui/index.html 读
  }

  // 界面上的「网页端」下拉：同一个对话窗口导航过去，不重开浏览器。
  const siteState = () => ({
    key: siteKey,
    label: siteDef.label,
    canSwitch: !opts.cdp && !opts.urlGiven && !opts.match,
  });

  const switchSite = async (raw) => {
    const key = String(raw || '').toLowerCase();
    const def = SITES[key];
    if (!def) throw new Error(`只支持 ${Object.keys(SITES).join(' / ')}`);
    if (!siteState().canSwitch) throw new Error('这次启动用 --url 或 --match 指定了页面，不能切换网页端');
    if (agent.busy) throw new Error('任务还在跑，跑完再切');
    if (key === siteKey) return siteState();
    // 页面连接断过就先把它接回来，别让一次断线卡住整个切换。
    if (!agent.site?.cdp || agent.site.cdp.closed) {
      agent.setConnection('connecting', '正在重新接上页面');
      await connect().catch(() => {});
    }
    const tab = agent.site?.cdp;
    if (!tab || tab.closed) throw new Error('对话页还没接上，稍等一下再切');
    const prev = { siteKey, siteDef, siteUrl, match: runtime.match };
    siteKey = key;
    siteDef = def;
    siteUrl = def.url;
    runtime.match = def.match;
    agent.setConnection('connecting', `正在切到 ${def.label}`);
    try {
      // 在同一个标签页里换地址，CDP 会话不跟着失效，不用重新 attach。
      await tab.send('Page.navigate', { url: siteUrl }, { timeoutMs: 2_000 }).catch(() => {});
      // 等标签页真的落到新站点上：网络不通时导航会一直挂着，
      // 不确认就切过去的话，用户会卡在一个“标签是 Gemini、页面还是 DeepSeek”的状态里。
      // 不能用 /json/list 的 url 判断：导航失败时它也显示目标地址。
      // 直接问页面自己，文档真换成新站点了才算落地。
      let landed = false;
      for (let i = 0; i < 6 && !landed; i++) {
        try {
          const r = await tab.evaluate('({ href: location.href, ready: document.readyState })', { timeoutMs: 1_000 });
          landed = !!r && String(r.href || '').includes(def.match) && r.ready !== 'loading';
        } catch {
          // 导航还没完成时求值会超时/被取消，继续等下一轮
        }
        if (!landed) await sleep(500);
      }
      if (!landed) throw new Error(`打不开 ${def.label}：页面没加载出来（网络断了？）`);
      agent.site = def.create(tab, { url: siteUrl });
      await saveConfig({ site: key });
      agent.setConnection('connecting', `正在打开 ${def.label}`);
      // 不在这里等页面加载完：网络慢或站点打不开时也能马上把下拉切过去，
      // 状态交给 refreshPage 和 watchPage 继续跟进。
      agent.refreshPage().catch(() => {});
      console.log(`  网页端  已切到 ${def.label}`);
      return siteState();
    } catch (err) {
      siteKey = prev.siteKey;
      siteDef = prev.siteDef;
      siteUrl = prev.siteUrl;
      runtime.match = prev.match;
      await tab.send('Page.navigate', { url: prev.siteUrl }, { timeoutMs: 8_000 }).catch(() => {});
      await sleep(400);
      await agent.refreshPage().catch(() => {});
      throw err;
    }
  };

  const server = await startServer({
    agent,
    uiDir,
    uiHtml,
    port: opts.port,
    browser: {
      get: browserState,
      set: (name) => switchBrowser(name),
    },
    sites: {
      get: siteState,
      set: (key) => switchSite(key),
    },
    version: VERSION,
    onFocus: async () => {
      const ok = await focusTarget({ port: runtime.port, wsPath: runtime.wsPath, urlIncludes: runtime.match });
      // 无缝切换时对话窗口被收在屏幕外，这里搬回来（在屏上的窗口不会被动）。
      await revealWindow({ port: runtime.port, wsPath: runtime.wsPath, urlIncludes: runtime.match }).catch(() => {});
      return ok;
    },
    onWarm: () => warmOther(),
  });

  console.log(`\n  Web Agent ${VERSION}`);
  console.log(`  工作区  ${agent.workspace || '（还没选，进界面里选）'}`);
  console.log(`  网页端  ${siteDef.label}`);
  console.log(`  界面    ${server.url}`);
  console.log(`  浏览器  ${opts.cdp ? `接入已有端口 ${opts.cdp}` : info.name}${info.profileDir ? ` · ${info.profileDir}` : ''}`);
  console.log(`  日志    ${log.file}`);
  console.log('  退出    Ctrl+C\n');

  await writeInstance({
    port: server.port,
    url: server.url,
    browser: info.name,
    profileDir: info.profileDir,
    version: VERSION,
  }).catch(() => {});

  if (opts.window && !opts.headless && !info.profileDir) {
    console.log('  提示    接入的是已有浏览器，请手动打开上面的界面地址');
  }

  let closing = false;
  let recovering = false;
  const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

  // 浏览器进程没了（用户关窗口、浏览器崩溃）时，自己把连接拉回来。
  const recover = async (reason, { quick = false } = {}) => {
    if (closing || recovering || opts.noRecover) return;
    recovering = true;
    try {
      const match = runtime.match || siteDef.match;
      // Chrome 启动器会先退出、真正的浏览器进程稍后才接手端口。
      // 多等几秒再判断，避免把“进程交接”误当成崩溃、重复开窗口。
      let hasPage = false;
      for (let i = 0; i < (quick ? 0 : 6) && !hasPage; i++) {
        const pages = await listPages(runtime.port).catch(() => null);
        hasPage = !!pages?.some((p) => (p.url || '').includes(match));
        if (!hasPage) await sleep(400);
      }
      // 浏览器还活着、只是页面那条 CDP 连接断了（对话窗口被关掉、标签页崩了）：
      // 重新接上页面就够了，别把整个浏览器重启掉（界面窗口也在里面）。
      const anyPage = !!(await listPages(runtime.port).catch(() => null))?.some((p) => p.type === 'page');
      if (hasPage || anyPage) {
        if (hasPage && agent.site?.cdp && !agent.site.cdp.closed) return;
        agent.setConnection('connecting', '正在重新接上页面');
        for (let i = 0; i < 3 && !closing; i++) {
          try {
            await connect();
            return;
          } catch (err) {
            console.warn(`  重新连接失败：${err.message}`);
            await sleep(1000 * (i + 1));
          }
        }
      }
      // 界面窗口和浏览器是一体的：浏览器没了就说明用户想退出了。
      // 这里要是再把它拉起来，用户关一次就重开一次，永远退不掉。
      if (opts.window && !opts.headless && !opts.cdp && !opts.keepBrowser) {
        await shutdown(0, '浏览器已关闭');
        return;
      }
      console.warn(`  浏览器不可用（${reason}），正在恢复…`);
      agent.push({ type: 'notice', text: '浏览器窗口关掉了，正在重新打开…' });
      agent.setConnection('connecting', '正在重新打开浏览器');
      for (let i = 0; i < 3 && !closing; i++) {
        await sleep(1200 * (i + 1));
        while (agent.busy && !closing) await sleep(2000); // 别在任务中途换页面
        try {
          await connect();
          return;
        } catch (err) {
          console.warn(`  恢复失败：${err.message}`);
        }
      }
      agent.setConnection('error', '浏览器反复退出，请重启程序');
    } finally {
      recovering = false;
    }
  };

  const watch = (launch) => {
    const proc = launch?.proc;
    if (!proc) return;
    proc.once('exit', () => {
      if (closing || runtime.launched?.proc !== proc) return;
      setTimeout(() => recover('浏览器进程退出'), 1200);
    });
  };

  // 界面窗口跟着当前浏览器走：同一个浏览器里只开一个，换浏览器时在新浏览器里开一个，
  // 然后再把旧浏览器关掉，用户始终只看见一个 Web Agent 窗口。
  const hasUiPage = async (port) => {
    const pages = await listPages(port).catch(() => null);
    return !!pages?.some((p) => (p.url || '').startsWith(server.url));
  };

  const ensureAppWindow = async (port, wsPath, { create = false } = {}) => {
    if (!opts.window || opts.headless || !info.profileDir) return 0;
    if (await hasUiPage(port)) {
      uiWindowPort = port;
      await focusTarget({ port, wsPath, urlIncludes: server.url }).catch(() => {});
      // 预热过的浏览器窗口开在屏幕外，界面窗口会继承那个位置：任务栏有图标但点不出来。
      await revealWindow({ port, wsPath, urlIncludes: server.url, left: 10, top: 10 }).catch(() => {});
      await dedupeAppWindows({ port, wsPath, url: server.url }).catch(() => {});
      return port;
    }
    if (!create || uiWindowPort === port) return 0;
    openAppWindow({ exe: info.exe, profileDir: info.profileDir, url: server.url });
    // 开窗口是异步的，马上查一定查不到；必须等界面页真的出现，否则后面
    // watchUiWindow 会把“还没出来”当成“界面被关了”，直接把整个程序退出。
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      if (await hasUiPage(port)) {
        uiWindowPort = port;
        // 新窗口会落在上次的位置（可能和对话窗口完全重叠），摆到左上角分开。
        await revealWindow({ port, wsPath, urlIncludes: server.url, left: 10, top: 10, force: true }).catch(() => {});
        // 以前几次启动留下的界面窗口（地址是别的端口、已经打不开了）顺手清掉，
        // 任务栏只留当前这一个。
        await dedupeAppWindows({ port, wsPath, url: server.url }).catch(() => {});
        return port;
      }
    }
    return 0;
  };

  const connect = async ({ closeOld = null } = {}) => {
    agent.setConnection('connecting');
    let port;
    let wsPath;
    if (opts.cdp) {
      port = opts.cdp;
      wsPath = await browserWsPath(port);
      if (!wsPath) throw new Error(`端口 ${port} 上没有可用的 DevTools 接口`);
    } else {
      const launch = await launchBrowser({
        exe: info.exe,
        profileDir: info.profileDir,
        url: siteUrl,
        headless: opts.headless,
      });
      runtime.launched = launch;
      if (launch.spawned && !runtime.opened.includes(launch)) runtime.opened.push(launch);
      watch(launch);
      port = launch.port;
      wsPath = launch.wsPath;
    }
    runtime.port = port;
    runtime.wsPath = wsPath;
    runtime.match = opts.match || siteDef.match;

    // 浏览器里还一个页面都没有（比如预热着的那个）就别干等，直接开标签页；
    // 有页面时 attachPage 通常几十毫秒就命中。
    // 换浏览器时站点页面可能还在加载（甚至打不开），别在这里干等满 8+15 秒：
    // 等不到就拿新开的那个标签页，真正的重试交给 waitReady 和 watchPage。
    const fast = info.switching;
    const pages = await listPages(port).catch(() => null);
    // 只看站点页面在不在：界面页在、对话页被关掉的时候别在这儿干等 8 秒。
    const hasSite = !!pages?.some((p) => p.type === 'page' && (p.url || '').includes(runtime.match));
    let cdp = hasSite
      ? await attachPage(port, { urlIncludes: runtime.match, timeoutMs: fast ? 3_000 : 8000 })
      : null;
    if (!cdp && !opts.cdp) {
      await createTarget({ port, wsPath, url: siteUrl }).catch(() => {});
      cdp = await attachPage(port, { urlIncludes: runtime.match, timeoutMs: fast ? 5_000 : 15_000 });
    }
    if (!cdp) throw new Error(`没找到 ${siteDef.label} 页面，可以在浏览器里手动打开 ${siteUrl} 再试`);

    agent.site = siteDef.create(cdp, { url: siteUrl });

    // 页面这条连接断了（对话窗口被关掉、标签页崩了）时自己重连，不用用户重开程序。
    cdp.on('__close', () => {
      if (closing || agent.site?.cdp !== cdp) return;
      agent.setConnection('connecting', '连接断开了，正在重连');
      setTimeout(() => recover('页面连接断开', { quick: true }), 300);
    });

    // 对话页接上之后再开界面窗口：两个 Chrome 进程同时对着一个 profile 抢启动
    // 会多出一个 about:blank 目标，接上去就是空白页。
    // 新浏览器里界面窗口开出来了才关旧的：任何时刻都只有一个浏览器，
    // 任务栏里不会留下点不开的图标。
    const uiPort = await ensureAppWindow(port, wsPath, { create: true });
    if (closeOld?.port && uiPort) {
      await closeBrowser({ port: closeOld.port, wsPath: closeOld.wsPath, proc: closeOld.proc, timeoutMs: 800 }).catch(() => {});
      runtime.opened = runtime.opened.filter((l) => l !== closeOld);
      console.log('  浏览器  旧窗口已关闭');
    } else if (closeOld?.port) {
      console.log('  浏览器  新窗口还没出来，旧浏览器先留着');
    }
    // 浏览器会记住上次窗口位置；以前挪到屏幕外的那些位置会被恢复成“半个窗在屏幕外”，
    // 任务栏点了也像打不开。接上之后统一摆回屏幕内。
    if (opts.window && !opts.headless) {
      await revealWindow({ port, wsPath, urlIncludes: runtime.match }).catch(() => {});
    }
    // 换浏览器时不干等页面把编辑器渲染出来：窗口已经切过去了，真正的等待交给发消息时的
    // ensureReady；这样点一下下拉就换完了，不会卡在“正在切换”上好几秒。
    const page = await agent.site.waitReady({ timeoutMs: info.switching ? 2_500 : 20_000 }).catch(() => null);
    await agent.refreshPage().catch(() => {});

    if (opts.window && !opts.headless) {
      // 界面窗口在哪儿就调哪儿回前台；想看对话窗口时点侧栏的「打开 X 窗口」。
      const uiPort = uiWindowPort || port;
      await focusAppWindow({ port: uiPort, url: server.url }).catch(() => {});
    }
    if (page?.storageBlocked) {
      console.log(`  注意    浏览器禁用了网站数据，${siteDef.label} 可能加载不出来（检查 Cookie 设置）`);
    } else if (page?.signedOut) {
      console.log(`  登录    未登录 —— 请在打开的 ${siteDef.label} 窗口里登录`);
    } else if (page?.ok) {
      console.log('  登录    已连接');
    }

  };

  /** 没连上时每 15 秒重载一次页面：代理晚开、网络断一下，回来自己就通了。 */
  const watchPage = () => {
    const timer = setInterval(async () => {
      if (agent.busy) return;
      const state = agent.connection;
      if (state === 'ready' || state === 'signed-out' || state === 'connecting') return;
      await agent.site?.cdp?.send('Page.reload', { ignoreCache: true }, { timeoutMs: 5_000 }).catch(() => {});
      await agent.refreshPage().catch(() => {});
    }, 15_000);
    timer.unref?.();
  };

  /** 上次没退干净时，另一个 profile 的浏览器还在跑：启动时收掉，免得看见两个浏览器。 */
  const closeStaleBrowser = async () => {
    if (opts.cdp || opts.headless || !opts.window || opts.keepBrowser) return;
    const other = info.name === 'chrome' ? 'edge' : 'chrome';
    const otherProfile = defaultProfileDir(other);
    if (otherProfile === info.profileDir) return;
    const file = path.join(otherProfile, 'DevToolsActivePort');
    if (!fs.existsSync(file)) return;
    const port = Number(fs.readFileSync(file, 'utf8').trim().split('\n')[0]);
    if (!port) return;
    const wsPath = await browserWsPath(port).catch(() => null);
    if (!wsPath) return;
    const pages = await listPages(port).catch(() => null);
    if (!pages) return;
    await closeBrowser({ port, wsPath }).catch(() => {});
    console.log(`  清理    关掉了上次留下的 ${other}`);
  };

  /** 界面窗口就是主窗口：关掉它（两秒内没再出现）就整个退出，不留后台。 */
  const watchUiWindow = () => {
    if (!opts.window || opts.headless || !uiWindowPort) return;
    let misses = 0;
    const timer = setInterval(async () => {
      // 换浏览器时界面窗口正在搬，别在这里把程序数没了。
      if (runtime.switching) return;
      const pages = await listPages(uiWindowPort).catch(() => null);
      // 浏览器自己没了：界面随之消失，程序和浏览器一起退出（别等 recover 把它拉回来）。
      if (!pages) {
        if (++misses >= 2) { clearInterval(timer); shutdown(0, '浏览器已关闭'); }
        return;
      }
      if (pages.some((p) => (p.url || '').startsWith(server.url))) { misses = 0; return; }
      if (++misses >= 2) { clearInterval(timer); shutdown(0, '界面关闭'); }
    }, 2_000);
    timer.unref?.();
  };

  /** 把另一个浏览器也启动好（窗口开在屏幕外），换过去时只差把窗口搬回来。
   *  只在用户摸到浏览器下拉时调（/api/warm），启动时不自动开第二个浏览器。 */
  const warmOther = async () => {
    if (warmStarted) return;
    warmStarted = true;
    if (opts.cdp || opts.headless || !opts.window || !info.profileDir) return;
    const other = info.name === 'chrome' ? 'edge' : 'chrome';
    if (!['edge', 'chrome'].includes(other)) return;
    const otherProfile = defaultProfileDir(other);
    if (otherProfile === info.profileDir) return;
    const exe = findBrowser(other);
    if (!exe) return;
    try {
      // 开在屏幕外：页面照样加载好，但用户看不见这个窗口；切过去时再搬到正常位置。
      const launch = await launchBrowser({
        exe,
        profileDir: otherProfile,
        url: siteUrl,
        timeoutMs: 20_000,
        extraArgs: ['--window-position=-32000,-32000', '--window-size=1280,860'],
      });
      if (launch.spawned && !runtime.opened.includes(launch)) runtime.opened.push(launch);
      // 预热出来的窗口也别晾在屏幕外：最小化放着，任务栏点了能出来，也不占地方。
      if (launch.spawned) {
        await hideWindow({ port: launch.port, wsPath: launch.wsPath, urlIncludes: siteDef.match }).catch(() => {});
      }
    } catch { /* 预热失败不影响主流程，真要切的时候再冷启动 */ }
  };

  /** 运行时换浏览器：关掉当前窗口，用新 profile 重新连。 */
  const switchBrowser = async (raw) => {
    const name = String(raw || '').toLowerCase();
    if (!['edge', 'chrome'].includes(name)) throw new Error('只支持 edge 或 chrome');
    if (!info.canSwitch) throw new Error('启动时用 --profile 或 --cdp 指定了连接方式，运行时不能换浏览器');
    if (agent.busy) throw new Error('任务还在跑，跑完再换');
    if (info.switching) throw new Error('正在切换，稍等一下');
    if (name === info.name && runtime.launched) return browserState();

    info.switching = true;
    runtime.switching = true;
    agent.emit('change');
    agent.setConnection('connecting', `正在切换到 ${name === 'chrome' ? 'Chrome' : 'Edge'}`);
    const old = runtime.launched;
    const before = {
      exe: info.exe, name: info.name, profileDir: info.profileDir,
      port: runtime.port, wsPath: runtime.wsPath, match: runtime.match,
    };
    runtime.launched = null; // 先摘掉，避免旧进程退出触发自动恢复
    try {
      info.exe = findBrowser(name);
      info.name = browserName(info.exe);
      info.profileDir = defaultProfileDir(info.name);
      await saveConfig({ browser: info.name });
      // 新浏览器接上、界面窗口搬过去之后，把旧浏览器关掉：只剩一个浏览器，
      // 任务栏里的图标也都能正常打开。
      await connect({ closeOld: old });
      await writeInstance({
        port: server.port,
        url: server.url,
        browser: info.name,
        profileDir: info.profileDir,
        version: VERSION,
      }).catch(() => {});
      info.switching = false;
      runtime.switching = false;
      // 登录提示交给顶部的连接状态和胶囊提示，不再往对话里塞一条 notice。
      if (agent.page?.signedOut) {
        console.log(`  登录    ${name === 'chrome' ? 'Chrome' : 'Edge'} 还没登录 ${siteDef.label}，在窗口里登录一次就会记住`);
      }
      return browserState();
    } catch (err) {
      // 新浏览器没接上：回到原来那个（进程还活着），别把用户丢在空窗口上
      info.exe = before.exe;
      info.name = before.name;
      info.profileDir = before.profileDir;
      runtime.launched = old;
      runtime.port = before.port;
      runtime.wsPath = before.wsPath;
      runtime.match = before.match;
      agent.setConnection('error', `切换到 ${name} 失败：${err.message}`);
      throw err;
    } finally {
      info.switching = false;
      runtime.switching = false;
      agent.emit('change'); // 新窗口可能在切换中途就打开了，补一次推送把下拉解锁
    }
  };

  const startBrowser = async (attempt = 1) => {
    try {
      await connect();
      await closeStaleBrowser().catch(() => {});
      watchUiWindow();
      watchPage();
    } catch (err) {
      // 窗口模式下浏览器起不来就真的没有界面了：重试一次，还不行就退出，别留个后台僵尸。
      if (attempt < 2 && opts.window && !opts.headless && !opts.cdp && !closing) {
        console.warn(`  连接失败：${err.message}，3 秒后重试…`);
        await new Promise((r) => { const t = setTimeout(r, 3000); t.unref?.(); });
        return startBrowser(attempt + 1);
      }
      agent.setConnection('error', err.message || String(err));
      console.error(`\n  连接失败：${err.message}\n`);
      if (opts.window && !opts.headless && !opts.cdp) await shutdown(1, '浏览器没起来');
    }
  };
  startBrowser();

  const shutdown = async (code = 0, why = '') => {
    if (closing) return;
    closing = true;
    await clearInstance().catch(() => {});
    log.write(`退出 code=${code}${why ? ` ${why}` : ''}`);
    console.log(`\n  正在退出…${why ? `（${why}）` : ''}`);
    agent.dispose();
    await server.close().catch(() => {});
    if (!opts.keepBrowser) {
      // 换过浏览器的话这里可能有好几个，一起收掉（旧窗口是切换时故意留着的）。
      for (const launch of runtime.opened) {
        if (!launch?.spawned) continue;
        await closeBrowser({ port: launch.port, wsPath: launch.wsPath, proc: launch.proc }).catch(() => {});
      }
    }
    process.exit(code);
  };
  process.on('SIGINT', () => shutdown(0, 'Ctrl+C'));
  process.on('SIGTERM', () => shutdown(0, 'SIGTERM'));
  process.on('SIGHUP', () => shutdown(0, 'SIGHUP'));
  process.on('exit', (code) => log.write(`进程结束 code=${code}`));
  // 单条链路出错不该带走整个程序：记下来、在界面提示，然后继续服务。
  process.on('unhandledRejection', (err) => {
    console.error('未处理的异步错误', err);
    agent.push({ type: 'notice', text: `内部错误：${err?.message || err}` });
  });
  process.on('uncaughtException', (err) => {
    console.error('未捕获的异常', err);
    agent.push({ type: 'notice', text: `内部错误：${err?.message || err}` });
  });
}

main().catch((err) => {
  console.error(`\n  启动失败：${err.message}\n`);
  if (process.env.WEB_AGENT_DEBUG) console.error(err);
  process.exit(1);
});
